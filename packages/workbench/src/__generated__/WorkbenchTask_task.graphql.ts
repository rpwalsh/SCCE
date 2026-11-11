/**
 * @generated SignedSource<<23c7f3703c91165fe1ef2e43e6549f92>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type WorkbenchTask_task$data = {
  readonly frames: {
    readonly edges: ReadonlyArray<{
      readonly node: {
        readonly id: string;
        readonly kind: string;
        readonly phase: string | null | undefined;
        readonly sequence: number;
      };
    }>;
  };
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
  readonly " $fragmentType": "WorkbenchTask_task";
};
export type WorkbenchTask_task$key = {
  readonly " $data"?: WorkbenchTask_task$data;
  readonly " $fragmentSpreads": FragmentRefs<"WorkbenchTask_task">;
};

import WorkbenchTaskPaginationQuery_graphql from './WorkbenchTaskPaginationQuery.graphql';

const node: ReaderFragment = (function(){
var v0 = [
  "frames"
],
v1 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "id",
  "storageKey": null
},
v2 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "status",
  "storageKey": null
},
v3 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "phase",
  "storageKey": null
},
v4 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "kind",
  "storageKey": null
},
v5 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "answer",
  "storageKey": null
},
v6 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "error",
  "storageKey": null
},
v7 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "sequence",
  "storageKey": null
},
v8 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "detail",
  "storageKey": null
};
return {
  "argumentDefinitions": [
    {
      "defaultValue": 20,
      "kind": "LocalArgument",
      "name": "count"
    },
    {
      "defaultValue": null,
      "kind": "LocalArgument",
      "name": "cursor"
    }
  ],
  "kind": "Fragment",
  "metadata": {
    "connection": [
      {
        "count": "count",
        "cursor": "cursor",
        "direction": "forward",
        "path": (v0/*:: as any*/)
      }
    ],
    "refetch": {
      "connection": {
        "forward": {
          "count": "count",
          "cursor": "cursor"
        },
        "backward": null,
        "path": (v0/*:: as any*/)
      },
      "fragmentPathInResult": [
        "node"
      ],
      "operation": WorkbenchTaskPaginationQuery_graphql,
      "identifierInfo": {
        "identifierField": "id",
        "identifierQueryVariableName": "id"
      }
    }
  },
  "name": "WorkbenchTask_task",
  "selections": [
    (v1/*:: as any*/),
    (v2/*:: as any*/),
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
        (v1/*:: as any*/),
        (v3/*:: as any*/),
        (v4/*:: as any*/),
        (v5/*:: as any*/),
        (v6/*:: as any*/),
        (v7/*:: as any*/),
        (v2/*:: as any*/),
        (v8/*:: as any*/),
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
        (v1/*:: as any*/),
        (v5/*:: as any*/),
        (v6/*:: as any*/),
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
        (v8/*:: as any*/),
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
            (v1/*:: as any*/),
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
    },
    {
      "alias": "frames",
      "args": null,
      "concreteType": "TurnFrameConnection",
      "kind": "LinkedField",
      "name": "__WorkbenchTask_frames_connection",
      "plural": false,
      "selections": [
        {
          "alias": null,
          "args": null,
          "concreteType": "TurnFrameEdge",
          "kind": "LinkedField",
          "name": "edges",
          "plural": true,
          "selections": [
            {
              "alias": null,
              "args": null,
              "concreteType": "TurnFrame",
              "kind": "LinkedField",
              "name": "node",
              "plural": false,
              "selections": [
                (v1/*:: as any*/),
                (v7/*:: as any*/),
                (v4/*:: as any*/),
                (v3/*:: as any*/),
                {
                  "alias": null,
                  "args": null,
                  "kind": "ScalarField",
                  "name": "__typename",
                  "storageKey": null
                }
              ],
              "storageKey": null
            },
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "cursor",
              "storageKey": null
            }
          ],
          "storageKey": null
        },
        {
          "alias": null,
          "args": null,
          "concreteType": "PageInfo",
          "kind": "LinkedField",
          "name": "pageInfo",
          "plural": false,
          "selections": [
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "endCursor",
              "storageKey": null
            },
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "hasNextPage",
              "storageKey": null
            }
          ],
          "storageKey": null
        }
      ],
      "storageKey": null
    }
  ],
  "type": "TurnTask",
  "abstractKey": null
};
})();

(node as any).hash = "1f9c63d4f0f1a862ee54209d37381521";

export default node;
