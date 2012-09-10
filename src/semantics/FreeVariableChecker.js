// Copyright 2011 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

traceur.define('semantics', function() {
  'use strict';

  var TokenType = traceur.syntax.TokenType;
  var ParseTreeVisitor = traceur.syntax.ParseTreeVisitor;
  var IdentifierToken = traceur.syntax.IdentifierToken;
  var IdentifierExpression = traceur.syntax.trees.IdentifierExpression;
  var BindingIdentifier = traceur.syntax.trees.BindingIdentifier;
  var ParseTreeType = traceur.syntax.trees.ParseTreeType;
  var SourcePosition = traceur.syntax.SourcePosition;
  var PredefinedName = traceur.syntax.PredefinedName;

  /**
   * Finds the identifiers that are not bound in a program. Run this after all
   * module imports have been resolved.
   *
   * This is run after all transformations to simplify the analysis. In
   * particular we can ignore:
   *   - module imports
   *   - block scope (let/const)
   *   - for of
   *   - generators
   *   - destructuring/rest
   *   - classes
   * as all of these nodes will have been replaced. We assume that synthetic
   * variables (generated by Traceur) will bind correctly, so we don't worry
   * about binding them as well as user defined variables.
   *
   * @param {ErrorReporter} reporter
   * @extends {ParseTreeVisitor}
   * @constructor
   */
  function FreeVariableChecker(reporter) {
    ParseTreeVisitor.call(this);
    this.reporter_ = reporter;
  }

  /**
   * Represents the link in the scope chain.
   * @param {Scope} parent The parent scope, or null if top level scope.
   * @constructor
   */
  function Scope(parent) {
    this.parent = parent;
    this.references = Object.create(null);
    this.declarations = Object.create(null);
  }

  /**
   * Gets the name of an identifier expression or token
   * @param {BindingIdentifier|IdentifierToken|string} name
   * @returns {string}
   */
  function getVariableName(name) {
    if (name instanceof IdentifierExpression) {
      name = name.identifierToken;
    } else if (name instanceof BindingIdentifier) {
      name = name.identifierToken;
    }
    if (name instanceof IdentifierToken) {
      name = name.value;
    }
    return name;
  }

  function getIdentifier(tree) {
    while (tree.type == ParseTreeType.PAREN_EXPRESSION) {
      tree = tree.expression;
    }
    if (tree.type == ParseTreeType.BINDING_IDENTIFIER) {
      return tree;
    }
    return null;
  }

  var global = ('global', eval)('this');

  /**
   * Checks the program for free variables, and reports an error when it
   * encounters any.
   *
   * @param {ErrorReporter} reporter
   * @param {Program} tree
   */
  FreeVariableChecker.checkProgram = function(reporter, tree) {
    new FreeVariableChecker(reporter).visitProgram(tree, global);
  }

  var proto = ParseTreeVisitor.prototype;
  FreeVariableChecker.prototype = traceur.createObject(proto, {

    /** Current scope (block, program) */
    scope_: null,

    /**
     * Pushes a scope.
     * @return {Scope}
     */
    pushScope_: function() {
      return this.scope_ = new Scope(this.scope_);
    },

    /**
     * Pops scope, tracks proper matching of push_/pop_ operations.
     * @param {Scope} scope
     */
    pop_: function(scope) {
      if (this.scope_ != scope) {
        throw new Error('FreeVariableChecker scope mismatch');
      }

      this.validateScope_();

      this.scope_ = scope.parent;
    },

    visitBlock: function(tree) {
      // block scope was already dealt with
      this.visitStatements_(tree.statements);
    },

    visitProgram: function(tree, global) {
      var scope = this.pushScope_();

      // Declare variables from the global scope.
      // TODO(jmesserly): this should be done through the module loaders, and by
      // providing the user the option to import URLs like '@dom', but for now
      // just bind against everything in the global scope.
      var object = global;
      while (object) {
        Object.getOwnPropertyNames(object).forEach(this.declareVariable_, this);
        object = Object.getPrototypeOf(object);
      }

      this.visitStatements_(tree.programElements);

      this.pop_(scope);
    },

    visitStatements_: function(statements) {
      statements.forEach(function(s) {
        if (s.type == ParseTreeType.FUNCTION_DECLARATION) {
          // Declare the function's name in the outer scope.
          // We need to do this here, and not inside visitFunctionDeclaration,
          // because function expressions shouldn't have their names added. Only
          // in statement contexts does this happen.
          this.declareVariable_(s.name);
        }
        this.visitAny(s);
      }, this);
    },

    /**
     * Helper function for visitFunctionDeclaration and
     * visitArrowFunctionExpression.
     * @param {IdentifierToken} name This is null for the arrow function.
     * @param {FormalParameterList} formalParameterList
     * @param {Block} body
     * @private
     */
    visitFunction_: function(name, formalParameterList, body) {
      var scope = this.pushScope_();

      // Declare the function name, 'arguments' and formal parameters inside the
      // function
      if (name)
        this.declareVariable_(name);
      this.declareVariable_(PredefinedName.ARGUMENTS);
      this.visitAny(formalParameterList);

      this.visitAny(body);

      this.pop_(scope);
    },

    visitFunctionDeclaration: function(tree) {
      this.visitFunction_(tree.name, tree.formalParameterList,
                          tree.functionBody);
    },

    visitArrowFunctionExpression: function(tree) {
      this.visitFunction_(null, tree.formalParameters, tree.functionBody);
    },

    visitGetAccessor: function(tree) {
      var scope = this.pushScope_();

      this.visitAny(tree.body);

      this.pop_(scope);
    },

    visitSetAccessor: function(tree) {
      var scope = this.pushScope_();

      this.declareVariable_(tree.parameter.binding);
      this.visitAny(tree.body);

      this.pop_(scope);
    },

    visitCatch: function(tree) {
      var scope = this.pushScope_();

      this.visitAny(tree.binding);
      this.visitAny(tree.catchBody);

      this.pop_(scope);
    },

    visitVariableDeclarationList: function(tree) {
      if (tree.declarationType != TokenType.VAR) {
        throw new Error('let and const should have been rewritten');
      }

      tree.declarations.forEach(function(d) {
        this.declareVariable_(d.lvalue);
        this.visitAny(d.initializer);
      }, this);
    },

    visitBindingIdentifier: function(tree) {
      this.declareVariable_(tree);
    },

    visitIdentifierExpression: function(tree) {
      var name = getVariableName(tree);
      var scope = this.scope_;
      if (!(name in scope.references)) {
        scope.references[name] = tree.location;
      }
    },

    declareVariable_: function(tree) {
      var name = getVariableName(tree);
      if (name) {
        var scope = this.scope_;
        if (!(name in scope.declarations)) {
          scope.declarations[name] = tree.location;
        }
      }
    },

    /**
     * Once we've visited the body of a scope, we check that all variables were
     * declared. If they haven't been, we promote the references to the parent
     * scope (because ES can close over variables, as well as reference them
     * before declaration).
     *
     * At the top level scope we issue errors for any remaining free variables.
     */
    validateScope_: function() {
      var scope = this.scope_;

      // Promote any unresolved references to the parent scope.
      var errors = [];
      for (var name in scope.references) {
        if (!(name in scope.declarations)) {
          var location = scope.references[name];
          if (!scope.parent) {
            if (!location) {
              // If location is null, it means we're getting errors from code we
              // generated. This is an internal error.
              throw new Error('generated variable ' + name + ' is not defined');
            }

            // If we're at the top level scope, then issue an error for
            // remaining free variables.
            errors.push([location.start, '%s is not defined', name]);
          } else if (!(name in scope.parent.references)) {
            scope.parent.references[name] = location;
          }
        }
      }

      if (errors.length) {
        // Issue errors in source order.
        errors.sort(function(x, y) { return x[0].offset - y[0].offset; });
        errors.forEach(function(e) { this.reportError_.apply(this, e); }, this);
      }
    },

    /**
     * @param {SourcePosition} start location
     * @param {string} format
     * @param {...Object} var_args
     */
    reportError_: function(location, format, var_args) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = location;
      this.reporter_.reportError.apply(this.reporter_, args);
    }
  });

  return {
    FreeVariableChecker: FreeVariableChecker
  };
});
