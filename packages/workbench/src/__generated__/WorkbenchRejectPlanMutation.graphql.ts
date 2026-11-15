/**
 * @generated SignedSource<<a3c193c5cc23bbb9d9b332c0dfc9bdf0>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type VscodePlanCommandInput = {
  clientMutationId?: string | null | undefined;
  operationId: string;
  planId: string;
};
export type WorkbenchRejectPlanMutation$variables = {
  input: VscodePlanCommandInput;
};
export type WorkbenchRejectPlanMutation$data = {
  readonly vscodeRejectPlan: {
    readonly clientMutationId: string | null | undefined;
    readonly rejected: {
      readonly capabilityId: string;
      readonly planId: string;
    };
  };
};
export type WorkbenchRejectPlanMutation = {
  response: WorkbenchRejectPlanMutation$data;
  variables: WorkbenchRejectPlanMutation$variables;
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
    "concreteType": "VscodeRejectionPayload",
    "kind": "LinkedField",
    "name": "vscodeRejectPlan",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeApprovalDecision",
        "kind": "LinkedField",
        "name": "rejected",
        "plural": false,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "planId",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "capabilityId",
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "clientMutationId",
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
    "name": "WorkbenchRejectPlanMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "WorkbenchRejectPlanMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "40bbccc2db52f5c4c24ceabc249a5aee",
    "id": null,
    "metadata": {},
    "name": "WorkbenchRejectPlanMutation",
    "operationKind": "mutation",
    "text": "mutation WorkbenchRejectPlanMutation(\n  $input: VscodePlanCommandInput!\n) {\n  vscodeRejectPlan(input: $input) {\n    rejected {\n      planId\n      capabilityId\n    }\n    clientMutationId\n  }\n}\n"
  }
};
})();

(node as any).hash = "b5d37bb68d9d5f793c3122182f45b22d";

export default node;
