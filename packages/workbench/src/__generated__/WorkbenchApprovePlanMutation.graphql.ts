/**
 * @generated SignedSource<<839beaec124c1442e91eaf5db4c4d8f8>>
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
export type WorkbenchApprovePlanMutation$variables = {
  input: VscodePlanCommandInput;
};
export type WorkbenchApprovePlanMutation$data = {
  readonly vscodeApprovePlan: {
    readonly approved: {
      readonly capabilityId: string;
      readonly planId: string;
    };
    readonly clientMutationId: string | null | undefined;
  };
};
export type WorkbenchApprovePlanMutation = {
  response: WorkbenchApprovePlanMutation$data;
  variables: WorkbenchApprovePlanMutation$variables;
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
    "concreteType": "VscodeApprovalPayload",
    "kind": "LinkedField",
    "name": "vscodeApprovePlan",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeApprovalDecision",
        "kind": "LinkedField",
        "name": "approved",
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
    "name": "WorkbenchApprovePlanMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "WorkbenchApprovePlanMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "bcf33dd200a9de3b1fb95d9d4f27f40e",
    "id": null,
    "metadata": {},
    "name": "WorkbenchApprovePlanMutation",
    "operationKind": "mutation",
    "text": "mutation WorkbenchApprovePlanMutation(\n  $input: VscodePlanCommandInput!\n) {\n  vscodeApprovePlan(input: $input) {\n    approved {\n      planId\n      capabilityId\n    }\n    clientMutationId\n  }\n}\n"
  }
};
})();

(node as any).hash = "6f96447c7f9553bd7a54f288284a9e55";

export default node;
