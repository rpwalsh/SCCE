/**
 * @generated SignedSource<<feda06d18fcf7f7f147b06fe895b39ba>>
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
  "name": "phase",
  "storageKey": null
},
v3 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "kind",
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
  "name": "sequence",
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
        (v1/*:: as any*/),
        (v2/*:: as any*/),
        (v3/*:: as any*/),
        (v4/*:: as any*/),
        (v5/*:: as any*/),
        (v6/*:: as any*/)
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
                (v6/*:: as any*/),
                (v3/*:: as any*/),
                (v2/*:: as any*/),
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

(node as any).hash = "21bf990af383759d9e9e1ea9c3701906";

export default node;
