/**
 * @generated SignedSource<<8e655cdb84c0c4676faaf2d100598990>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type WorkbenchTaskQuery$variables = {
  id: string;
};
export type WorkbenchTaskQuery$data = {
  readonly turnTask: {
    readonly " $fragmentSpreads": FragmentRefs<"WorkbenchTask_task">;
  } | null | undefined;
};
export type WorkbenchTaskQuery = {
  response: WorkbenchTaskQuery$data;
  variables: WorkbenchTaskQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "id"
  }
],
v1 = [
  {
    "kind": "Variable",
    "name": "id",
    "variableName": "id"
  }
],
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
v8 = [
  {
    "kind": "Literal",
    "name": "first",
    "value": 20
  }
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "WorkbenchTaskQuery",
    "selections": [
      {
        "alias": null,
        "args": (v1/*:: as any*/),
        "concreteType": "TurnTask",
        "kind": "LinkedField",
        "name": "turnTask",
        "plural": false,
        "selections": [
          {
            "args": null,
            "kind": "FragmentSpread",
            "name": "WorkbenchTask_task"
          }
        ],
        "storageKey": null
      }
    ],
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "WorkbenchTaskQuery",
    "selections": [
      {
        "alias": null,
        "args": (v1/*:: as any*/),
        "concreteType": "TurnTask",
        "kind": "LinkedField",
        "name": "turnTask",
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
              (v3/*:: as any*/),
              (v4/*:: as any*/),
              (v5/*:: as any*/),
              (v6/*:: as any*/),
              (v7/*:: as any*/)
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
              }
            ],
            "storageKey": null
          },
          {
            "alias": null,
            "args": (v8/*:: as any*/),
            "concreteType": "TurnFrameConnection",
            "kind": "LinkedField",
            "name": "frames",
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
                      (v2/*:: as any*/),
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
            "storageKey": "frames(first:20)"
          },
          {
            "alias": null,
            "args": (v8/*:: as any*/),
            "filters": null,
            "handle": "connection",
            "key": "WorkbenchTask_frames",
            "kind": "LinkedHandle",
            "name": "frames"
          }
        ],
        "storageKey": null
      }
    ]
  },
  "params": {
    "cacheID": "8191a5ffc4500280a376225436f6a523",
    "id": null,
    "metadata": {},
    "name": "WorkbenchTaskQuery",
    "operationKind": "query",
    "text": "query WorkbenchTaskQuery(\n  $id: ID!\n) {\n  turnTask(id: $id) {\n    ...WorkbenchTask_task\n    id\n  }\n}\n\nfragment WorkbenchTask_task on TurnTask {\n  id\n  status\n  latestSequence\n  persistence\n  latestFrame {\n    id\n    phase\n    kind\n    answer\n    error\n    sequence\n  }\n  result {\n    id\n    answer\n    error\n    httpStatus\n    episodeId\n  }\n  frames(first: 20) {\n    edges {\n      node {\n        id\n        sequence\n        kind\n        phase\n        __typename\n      }\n      cursor\n    }\n    pageInfo {\n      endCursor\n      hasNextPage\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "632d48a02d0e3770ddfb45079530efdd";

export default node;
