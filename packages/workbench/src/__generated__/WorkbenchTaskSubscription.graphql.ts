/**
 * @generated SignedSource<<7bbbfa84c50feea7d3c48f1af1807fc3>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type WorkbenchTaskSubscription$variables = {
  afterSequence: number;
  id: string;
};
export type WorkbenchTaskSubscription$data = {
  readonly turnTaskUpdated: {
    readonly id: string;
    readonly latestFrame: {
      readonly answer: string | null | undefined;
      readonly error: string | null | undefined;
      readonly id: string;
      readonly kind: string;
      readonly phase: string | null | undefined;
      readonly sequence: number;
    } | null | undefined;
    readonly latestSequence: number;
    readonly persistence: string;
    readonly result: {
      readonly answer: string | null | undefined;
      readonly episodeId: string | null | undefined;
      readonly error: string | null | undefined;
      readonly httpStatus: number | null | undefined;
      readonly id: string;
    } | null | undefined;
    readonly status: string;
  };
};
export type WorkbenchTaskSubscription = {
  response: WorkbenchTaskSubscription$data;
  variables: WorkbenchTaskSubscription$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "afterSequence"
},
v1 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "id"
},
v2 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "id",
  "storageKey": null
},
v3 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "answer",
  "storageKey": null
},
v4 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "error",
  "storageKey": null
},
v5 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "afterSequence",
        "variableName": "afterSequence"
      },
      {
        "kind": "Variable",
        "name": "id",
        "variableName": "id"
      }
    ],
    "concreteType": "TurnTask",
    "kind": "LinkedField",
    "name": "turnTaskUpdated",
    "plural": false,
    "selections": [
      (v2/*:: as any*/),
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "status",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "latestSequence",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "persistence",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "TurnFrame",
        "kind": "LinkedField",
        "name": "latestFrame",
        "plural": false,
        "selections": [
          (v2/*:: as any*/),
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
            "name": "kind",
            "storageKey": null
          },
          (v3/*:: as any*/),
          (v4/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "sequence",
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "TurnResult",
        "kind": "LinkedField",
        "name": "result",
        "plural": false,
        "selections": [
          (v2/*:: as any*/),
          (v3/*:: as any*/),
          (v4/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "httpStatus",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "episodeId",
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
    "argumentDefinitions": [
      (v0/*:: as any*/),
      (v1/*:: as any*/)
    ],
    "kind": "Fragment",
    "metadata": null,
    "name": "WorkbenchTaskSubscription",
    "selections": (v5/*:: as any*/),
    "type": "Subscription",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [
      (v1/*:: as any*/),
      (v0/*:: as any*/)
    ],
    "kind": "Operation",
    "name": "WorkbenchTaskSubscription",
    "selections": (v5/*:: as any*/)
  },
  "params": {
    "cacheID": "7ef26412e9fedc1f0bd78451b187d905",
    "id": null,
    "metadata": {},
    "name": "WorkbenchTaskSubscription",
    "operationKind": "subscription",
    "text": "subscription WorkbenchTaskSubscription(\n  $id: ID!\n  $afterSequence: Int!\n) {\n  turnTaskUpdated(id: $id, afterSequence: $afterSequence) {\n    id\n    status\n    latestSequence\n    persistence\n    latestFrame {\n      id\n      phase\n      kind\n      answer\n      error\n      sequence\n    }\n    result {\n      id\n      answer\n      error\n      httpStatus\n      episodeId\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "fe26677a4f2196b6f361773220df7b2f";

export default node;
