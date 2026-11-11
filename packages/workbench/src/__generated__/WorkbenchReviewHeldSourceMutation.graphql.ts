/**
 * @generated SignedSource<<2db040ebc8fceff9dcc66373a3cc4012>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type VscodeReviewDecision = "promoted" | "rejected" | "%future added value";
export type VscodeReviewCommandInput = {
  clientMutationId?: string | null | undefined;
  decision: VscodeReviewDecision;
  id: string;
  operationId: string;
};
export type WorkbenchReviewHeldSourceMutation$variables = {
  input: VscodeReviewCommandInput;
};
export type WorkbenchReviewHeldSourceMutation$data = {
  readonly vscodeReviewHeldSource: {
    readonly clientMutationId: string | null | undefined;
    readonly review: {
      readonly decision: string;
      readonly id: string;
      readonly promotedEvidence: number;
    };
    readonly schema: string;
  };
};
export type WorkbenchReviewHeldSourceMutation = {
  response: WorkbenchReviewHeldSourceMutation$data;
  variables: WorkbenchReviewHeldSourceMutation$variables;
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
    "concreteType": "VscodeReviewHeldSourcePayload",
    "kind": "LinkedField",
    "name": "vscodeReviewHeldSource",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "clientMutationId",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "schema",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeHeldSourceReview",
        "kind": "LinkedField",
        "name": "review",
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
            "name": "decision",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "promotedEvidence",
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
    "name": "WorkbenchReviewHeldSourceMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "WorkbenchReviewHeldSourceMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "dccf8f895b25c0b1621907cd60103753",
    "id": null,
    "metadata": {},
    "name": "WorkbenchReviewHeldSourceMutation",
    "operationKind": "mutation",
    "text": "mutation WorkbenchReviewHeldSourceMutation(\n  $input: VscodeReviewCommandInput!\n) {\n  vscodeReviewHeldSource(input: $input) {\n    clientMutationId\n    schema\n    review {\n      id\n      decision\n      promotedEvidence\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "f93f42420b7c642d85cc09b1520cbcb6";

export default node;
