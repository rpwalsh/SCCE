/**
 * @generated SignedSource<<7eb821154117ae5e0d1d9116cf7c62ae>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type WorkbenchDataQuery$variables = Record<PropertyKey, never>;
export type WorkbenchDataQuery$data = {
  readonly vscodeWorkspaceStatus: {
    readonly sources: ReadonlyArray<{
      readonly path: string;
    }>;
    readonly workspace: {
      readonly id: string;
      readonly rootPath: string;
      readonly updatedAt: number;
    } | null | undefined;
  };
};
export type WorkbenchDataQuery = {
  response: WorkbenchDataQuery$data;
  variables: WorkbenchDataQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "alias": null,
    "args": null,
    "concreteType": "VscodeWorkspaceStatusResult",
    "kind": "LinkedField",
    "name": "vscodeWorkspaceStatus",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeWorkspace",
        "kind": "LinkedField",
        "name": "workspace",
        "plural": false,
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
            "name": "rootPath",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "updatedAt",
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeWorkspaceSource",
        "kind": "LinkedField",
        "name": "sources",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "path",
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "WorkbenchDataQuery",
    "selections": (v0/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "WorkbenchDataQuery",
    "selections": (v0/*:: as any*/)
  },
  "params": {
    "cacheID": "ceaf5898d5749d8107ec1a86074753ac",
    "id": null,
    "metadata": {},
    "name": "WorkbenchDataQuery",
    "operationKind": "query",
    "text": "query WorkbenchDataQuery {\n  vscodeWorkspaceStatus {\n    workspace {\n      id\n      rootPath\n      updatedAt\n    }\n    sources {\n      path\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "b31a8f72943e7547a5e6508d8f78cde6";

export default node;
