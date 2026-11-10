/**
 * @generated SignedSource<<45bd9f92a75c074382b19eb66a041a10>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type CancelTurnInput = {
  clientMutationId?: string | null | undefined;
  taskId: string;
};
export type WorkbenchCancelMutation$variables = {
  input: CancelTurnInput;
};
export type WorkbenchCancelMutation$data = {
  readonly cancelTurn: {
    readonly task: {
      readonly id: string;
      readonly latestSequence: number;
      readonly status: string;
    };
  };
};
export type WorkbenchCancelMutation = {
  response: WorkbenchCancelMutation$data;
  variables: WorkbenchCancelMutation$variables;
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
    "name": "cancelTurn",
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
    "name": "WorkbenchCancelMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "WorkbenchCancelMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "719777f57575c35f409fa9affbc434ed",
    "id": null,
    "metadata": {},
    "name": "WorkbenchCancelMutation",
    "operationKind": "mutation",
    "text": "mutation WorkbenchCancelMutation(\n  $input: CancelTurnInput!\n) {\n  cancelTurn(input: $input) {\n    task {\n      id\n      status\n      latestSequence\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "a11c2e6d0dbad87616e4dd60bc70efbf";

export default node;
