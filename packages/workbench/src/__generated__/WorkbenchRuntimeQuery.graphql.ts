/**
 * @generated SignedSource<<b0252c834c02f1fd1ff463560a928214>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type WorkbenchRuntimeQuery$variables = Record<PropertyKey, never>;
export type WorkbenchRuntimeQuery$data = {
  readonly runtime: {
    readonly generation: string;
    readonly phase: string;
    readonly protocolVersion: string;
    readonly ready: boolean;
  };
};
export type WorkbenchRuntimeQuery = {
  response: WorkbenchRuntimeQuery$data;
  variables: WorkbenchRuntimeQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "alias": null,
    "args": null,
    "concreteType": "RuntimeStatus",
    "kind": "LinkedField",
    "name": "runtime",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "protocolVersion",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "generation",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "phase",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "ready",
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
    "name": "WorkbenchRuntimeQuery",
    "selections": (v0/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "WorkbenchRuntimeQuery",
    "selections": (v0/*:: as any*/)
  },
  "params": {
    "cacheID": "20fc65a18b41849fcc9831db42f5d5b6",
    "id": null,
    "metadata": {},
    "name": "WorkbenchRuntimeQuery",
    "operationKind": "query",
    "text": "query WorkbenchRuntimeQuery {\n  runtime {\n    protocolVersion\n    generation\n    phase\n    ready\n  }\n}\n"
  }
};
})();

(node as any).hash = "8f74fa5a82145bd61d2c957ea7e15743";

export default node;
