/**
 * @generated SignedSource<<f1c62e345c2c19194e5f54310248b69f>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type RequestedAuthority = "action" | "creative" | "factual" | "program" | "reasoned" | "translation" | "%future added value";
export type StartTurnInput = {
  clientMutationId?: string | null | undefined;
  conversationId?: string | null | undefined;
  operationId: string;
  requestedAuthority?: RequestedAuthority | null | undefined;
  sessionId?: string | null | undefined;
  text: string;
};
export type WorkbenchStartMutation$variables = {
  input: StartTurnInput;
};
export type WorkbenchStartMutation$data = {
  readonly startTurn: {
    readonly task: {
      readonly id: string;
      readonly latestSequence: number;
      readonly status: string;
    };
  };
};
export type WorkbenchStartMutation = {
  response: WorkbenchStartMutation$data;
  variables: WorkbenchStartMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "input"
  }
],
v1 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "input",
        "variableName": "input"
      }
    ],
    "concreteType": "TurnTaskPayload",
    "kind": "LinkedField",
    "name": "startTurn",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "TurnTask",
        "kind": "LinkedField",
        "name": "task",
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
            "name": "status",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "latestSequence",
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
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "WorkbenchStartMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "WorkbenchStartMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "2b7cc6d3e915433ad7ed4628f5335424",
    "id": null,
    "metadata": {},
    "name": "WorkbenchStartMutation",
    "operationKind": "mutation",
    "text": "mutation WorkbenchStartMutation(\n  $input: StartTurnInput!\n) {\n  startTurn(input: $input) {\n    task {\n      id\n      status\n      latestSequence\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "bd7a49972aefc419fb86e7c439dc914c";

export default node;
