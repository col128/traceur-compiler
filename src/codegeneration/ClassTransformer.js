// Copyright 2012 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import ParseTreeType from '../syntax/trees/ParseTree.js';
import {
  CONSTRUCTOR,
  CREATE_CLASS,
  RUNTIME,
  TRACEUR
} from '../syntax/PredefinedName.js';
import SuperTransformer from 'SuperTransformer.js';
import TempVarTransformer from 'TempVarTransformer.js';
import TokenType from '../syntax/TokenType.js';
import {
  createArgumentList,
  createAssignmentExpression,
  createBlock,
  createBooleanLiteral,
  createCallExpression,
  createExpressionStatement,
  createFunctionExpression,
  createIdentifierExpression,
  createIdentifierToken,
  createMemberExpression,
  createNullLiteral,
  createObjectLiteralExpression,
  createParenExpression,
  createPropertyNameAssignment,
  createRestParameter,
  createSpreadExpression,
  createVariableStatement
} from 'ParseTreeFactory.js';
import createObject from '../util/util.js';
import transformOptions from '../options.js';
import trees from '../syntax/trees/ParseTrees.js';

var FormalParameterList = trees.FormalParameterList;
var FunctionDeclaration = trees.FunctionDeclaration;
var GetAccessor = trees.GetAccessor;
var PropertyMethodAssignment = trees.PropertyMethodAssignment;
var PropertyNameAssignment = trees.PropertyNameAssignment;
var SetAccessor = trees.SetAccessor;
var SuperExpression = trees.SuperExpression;

// The state keeps track of the current class tree and class name.
var stack = [];

function State(classTree) {
  this.tree = classTree;
  this.name = null;
  this.hasSuper = false;
}

function peekState() {
  return stack[stack.length - 1];
}

/**
 * Maximally minimal classes
 *
 *   http://wiki.ecmascript.org/doku.php?id=strawman:maximally_minimal_classes
 *
 * This transforms class declarations and class expressions.
 *
 *   class C extends B {
 *     constructor(x) {
 *       super();
 *     }
 *     method() {
 *       super.m();
 *     }
 *   }
 *
 *   =>
 *
 *   let C = traceur.runtime.createClass({
 *      constructor: function C(x) {
 *         traceur.runtime.superCall(this, C, 'constructor', [x]);
 *      },
 *      method: function method() {
 *        traceur.runtime.superCall(this, C, 'm', []);
 *      }
 *   });
 *
 * @param {UniqueIdentifierGenerator} identifierGenerator
 * @param {ErrorReporter} reporter
 * @constructor
 * @extends {TempVarTransformer}
 */
export function ClassTransformer(identifierGenerator, reporter) {
  TempVarTransformer.call(this, identifierGenerator);
  this.reporter_ = reporter;
}

/**
 * @param {UniqueIdentifierGenerator} identifierGenerator
 * @param {ErrorReporter} reporter
 * @param {Program} tree
 * @return {Program}
 */
ClassTransformer.transform = function(identifierGenerator, reporter, tree) {
  return new ClassTransformer(identifierGenerator, reporter).
      transformAny(tree);
};

var proto = TempVarTransformer.prototype;
ClassTransformer.prototype = createObject(proto, {

  transformClassShared_: function(tree, name) {
    var superClass = this.transformAny(tree.superClass);

    var state = new State(tree);
    stack.push(state);
    state.name = createIdentifierExpression(name);

    var constructor;
    var elements = tree.elements.map((tree) => {
      switch (tree.type) {
        case ParseTreeType.GET_ACCESSOR:
          return this.transformGetAccessor_(tree);
        case ParseTreeType.SET_ACCESSOR:
          return this.transformSetAccessor_(tree);
        case ParseTreeType.PROPERTY_METHOD_ASSIGNMENT:
          if (tree.name.value === CONSTRUCTOR)
            return constructor = this.transformConstructor_(tree);
          return this.transformPropertyMethodAssignment_(tree);
        default:
          throw new Error(`Unexpected class element: ${tree.type}`);
      }
    });

    // Create constructor if it does not already exist.
    if (!constructor)
      elements.push(this.getDefaultConstructor_(tree));

    stack.pop();

    // We need to keep track of whether we have a user defined constructor or
    // not in case we extend null.
    var hasConstructor = !!constructor;
    // A missing extends expression needs to be treated slightly different
    // from extending Object.
    var hasExtendsExpression = !!superClass;

    // let <className> = traceur.runtime.createClass(proto, superClass,
    //                                               hasConstructor,
    //                                               hasExtendsExpression)
    return [
      createCallExpression(
          createMemberExpression(TRACEUR, RUNTIME, CREATE_CLASS),
          createArgumentList(
              createObjectLiteralExpression(elements),
              superClass || createNullLiteral(),
              createBooleanLiteral(hasConstructor),
              createBooleanLiteral(hasExtendsExpression))),
      state.hasSuper
    ];
  },

  /**
   * Transforms a single class declaration
   *
   * @param {ClassDeclaration} tree
   * @return {ParseTree}
   */
  transformClassDeclaration: function(tree) {
    // let <className> = traceur.runtime.createClass(proto, superClass)
    return createVariableStatement(
        transformOptions.blockBinding ? TokenType.LET : TokenType.VAR,
        tree.name,
        this.transformClassShared_(tree, tree.name.identifierToken)[0]);
  },

  transformClassExpression: function(tree) {
    var tempIdent = this.addTempVar();
    var transformResult = this.transformClassShared_(tree, tempIdent);
    var classTree = transformResult[0];
    var hasSuper =  transformResult[1];
    if (hasSuper) {
      return createParenExpression(
          createAssignmentExpression(
              createIdentifierExpression(tempIdent),
              classTree));
    }

    this.removeTempVar(tempIdent);
    return classTree;
  },

  transformPropertyMethodAssignment_: function(tree) {
    var formalParameterList = this.transformAny(tree.formalParameterList);
    var functionBody = this.transformSuperInBlock_(tree, tree.functionBody);
    if (formalParameterList === tree.formalParameterList &&
        functionBody === tree.functionBody) {
      return tree;
    }

    return new PropertyMethodAssignment(tree.location, tree.name,
        tree.isGenerator, formalParameterList, functionBody);
  },

  transformGetAccessor_: function(tree) {
    var body = this.transformSuperInBlock_(tree, tree.body);
    if (body === tree.body)
      return tree;
    return new GetAccessor(tree.location, tree.propertyName, body);
  },

  transformSetAccessor_: function(tree) {
    var parameter = this.transformAny(tree.parameter);
    var body = this.transformSuperInBlock_(tree, tree.body);
    if (body === tree.body)
      return tree;
    return new SetAccessor(tree.location, tree.propertyName, parameter, body);
  },

  transformConstructor_: function(tree) {
    // The constructor is transformed into a property assignment.
    // constructor: function CLASS_NAME() { }
    var state = peekState();
    var parameters = this.transformAny(tree.formalParameterList);
    var functionBody = this.transformSuperInBlock_(tree, tree.functionBody);

    var func = createFunctionExpression(parameters, functionBody);
    return createPropertyNameAssignment(CONSTRUCTOR, func);
  },

  transformSuperInBlock_: function(methodTree, tree) {
    var state = peekState();
    var className = state.name;
    var superTransformer = new SuperTransformer(this, this.reporter_,
                                                className, methodTree);
    var transformedTree =
        superTransformer.transformAny(proto.transformAny.call(this, tree));
    if (superTransformer.hasSuper)
      state.hasSuper = true;
    return transformedTree;
  },

  getDefaultConstructor_: function(tree) {
    // function name(...args) {
    //   super(...args)
    // }
    var restParam = createRestParameter('args');
    var params = new FormalParameterList(null, [restParam]);
    var body = createBlock(
        createExpressionStatement(
            createCallExpression(
                new SuperExpression(null),
                createArgumentList(
                    createSpreadExpression(
                        createIdentifierExpression('args'))))));
    var constr = new PropertyMethodAssignment(null,
        createIdentifierToken(CONSTRUCTOR), false,
                              params, body);
    return this.transformConstructor_(constr);
  }
});
