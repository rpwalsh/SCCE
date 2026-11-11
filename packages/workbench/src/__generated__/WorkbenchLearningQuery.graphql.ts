/**
 * @generated SignedSource<<15732f636b916bdd74ea517ca11ddc47>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type WorkbenchLearningQuery$variables = Record<PropertyKey, never>;
export type WorkbenchLearningQuery$data = {
  readonly vscodeHeldSources: {
    readonly held: ReadonlyArray<{
      readonly evidenceCount: number;
      readonly id: string;
      readonly preview: string;
      readonly title: string;
      readonly uri: string;
    }>;
    readonly schema: string;
  };
  readonly vscodeLearningCurriculum: {
    readonly items: ReadonlyArray<{
      readonly planId: string;
      readonly query: string;
      readonly rationale: string;
    }>;
    readonly schema: string;
  };
};
export type WorkbenchLearningQuery = {
  response: WorkbenchLearningQuery$data;
  variables: WorkbenchLearningQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "schema",
  "storageKey": null
},
v1 = [
  {
    "alias": null,
    "args": null,
    "concreteType": "VscodeLearningCurriculumResult",
    "kind": "LinkedField",
    "name": "vscodeLearningCurriculum",
    "plural": false,
    "selections": [
      (v0/*:: as any*/),
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeCurriculumItem",
        "kind": "LinkedField",
        "name": "items",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "planId",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "query",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "rationale",
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ],
    "storageKey": null
  },
  {
    "alias": null,
    "args": [
      {
        "kind": "Literal",
        "name": "first",
        "value": 20
      }
    ],
    "concreteType": "VscodeHeldSourcesResult",
    "kind": "LinkedField",
    "name": "vscodeHeldSources",
    "plural": false,
    "selections": [
      (v0/*:: as any*/),
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeHeldSource",
        "kind": "LinkedField",
        "name": "held",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "id",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "uri",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "title",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "preview",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "evidenceCount",
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ],
    "storageKey": "vscodeHeldSources(first:20)"
  }
];
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "WorkbenchLearningQuery",
    "selections": (v1/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "WorkbenchLearningQuery",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "f809292c0b319bfc711eaeb163fc4c3c",
    "id": null,
    "metadata": {},
    "name": "WorkbenchLearningQuery",
    "operationKind": "query",
    "text": "query WorkbenchLearningQuery {\n  vscodeLearningCurriculum {\n    schema\n    items {\n      planId\n      query\n      rationale\n    }\n  }\n  vscodeHeldSources(first: 20) {\n    schema\n    held {\n      id\n      uri\n      title\n      preview\n      evidenceCount\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "98b9a1f84a2ebd95b60093a85f81f0f4";

export default node;
