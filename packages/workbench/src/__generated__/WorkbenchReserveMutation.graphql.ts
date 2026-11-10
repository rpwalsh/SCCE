/**
 * @generated SignedSource<<0feb64de1df8300eccfd9badeaf619c6>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type ReserveTurnInput = {
  clientMutationId?: string | null | undefined;
};
export type WorkbenchReserveMutation$variables = {
  input: ReserveTurnInput;
};
export type WorkbenchReserveMutation$data = {
  readonly reserveTurn: {
    readonly task: {
      readonly id: string;
      readonly status: string;
    };
  };
};
export type WorkbenchReserveMutation = {
  response: WorkbenchReserveMutation$data;
  variables: WorkbenchReserveMutation$variables;
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
    "name": "reserveTurn",
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
    "name": "WorkbenchReserveMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "WorkbenchReserveMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "e2880ae0a2c835283edba5090b01bd57",
    "id": null,
    "metadata": {},
    "name": "WorkbenchReserveMutation",
    "operationKind": "mutation",
    "text": "mutation WorkbenchReserveMutation(\n  $input: ReserveTurnInput!\n) {\n  reserveTurn(input: $input) {\n    task {\n      id\n      status\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "39532a83e7934d8a6f282a34cf37a030";

export default node;
