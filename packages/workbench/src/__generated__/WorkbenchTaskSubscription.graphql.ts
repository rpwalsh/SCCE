/**
 * @generated SignedSource<<8a66b793c7d77395d2e83138044d6011>>
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
      readonly assistantForce: string | null | undefined;
      readonly detail: any | null | undefined;
      readonly error: string | null | undefined;
      readonly id: string;
      readonly kind: string;
      readonly phase: string | null | undefined;
      readonly sequence: number;
      readonly status: number | null | undefined;
    } | null | undefined;
    readonly latestSequence: number;
    readonly persistence: string;
    readonly result: {
      readonly answer: string | null | undefined;
      readonly detail: any | null | undefined;
      readonly entailment: any | null | undefined;
      readonly episodeId: string | null | undefined;
      readonly error: string | null | undefined;
      readonly evidence: ReadonlyArray<{
        readonly id: string | null | undefined;
        readonly provenance: any | null | undefined;
        readonly sourceId: string | null | undefined;
        readonly textPreview: string | null | undefined;
      }> | null | undefined;
      readonly guardFlags: {
        readonly sourceBacked: boolean | null | undefined;
      } | null | undefined;
      readonly httpStatus: number | null | undefined;
      readonly id: string;
      readonly value: any | null | undefined;
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
  "name": "status",
  "storageKey": null
},
v4 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "answer",
  "storageKey": null
},
v5 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "error",
  "storageKey": null
},
v6 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "detail",
  "storageKey": null
},
v7 = [
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
      (v3/*:: as any*/),
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
          (v4/*:: as any*/),
          (v5/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "sequence",
            "storageKey": null
          },
          (v3/*:: as any*/),
          (v6/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "assistantForce",
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
          (v4/*:: as any*/),
          (v5/*:: as any*/),
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
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "value",
            "storageKey": null
          },
          (v6/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "entailment",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "TurnGuardFlags",
            "kind": "LinkedField",
            "name": "guardFlags",
            "plural": false,
            "selections": [
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "sourceBacked",
                "storageKey": null
              }
            ],
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "TurnAnswerEvidence",
            "kind": "LinkedField",
            "name": "evidence",
            "plural": true,
            "selections": [
              (v2/*:: as any*/),
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "sourceId",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "textPreview",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "provenance",
                "storageKey": null
              }
            ],
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
    "selections": (v7/*:: as any*/),
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
    "selections": (v7/*:: as any*/)
  },
  "params": {
    "cacheID": "efaa9c79cf26773c144b40cd1f4d6ae6",
    "id": null,
    "metadata": {},
    "name": "WorkbenchTaskSubscription",
    "operationKind": "subscription",
    "text": "subscription WorkbenchTaskSubscription(\n  $id: ID!\n  $afterSequence: Int!\n) {\n  turnTaskUpdated(id: $id, afterSequence: $afterSequence) {\n    id\n    status\n    latestSequence\n    persistence\n    latestFrame {\n      id\n      phase\n      kind\n      answer\n      error\n      sequence\n      status\n      detail\n      assistantForce\n    }\n    result {\n      id\n      answer\n      error\n      httpStatus\n      episodeId\n      value\n      detail\n      entailment\n      guardFlags {\n        sourceBacked\n      }\n      evidence {\n        id\n        sourceId\n        textPreview\n        provenance\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "907508f3175950eb813f77eac23999c0";

export default node;
