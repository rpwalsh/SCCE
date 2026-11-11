/**
 * @generated SignedSource<<b23f65cd3d2bf48a3f653e14dbd20031>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type LearnSourceInput = {
  bytesBase64: string;
  canonicalUri: string;
  clientMutationId?: string | null | undefined;
  mediaType: string;
  namespace: string;
  observedAt?: number | null | undefined;
  operationId: string;
  title?: string | null | undefined;
};
export type WorkbenchLearnSourceMutation$variables = {
  input: LearnSourceInput;
};
export type WorkbenchLearnSourceMutation$data = {
  readonly learnSource: {
    readonly clientMutationId: string | null | undefined;
    readonly evidenceId: string;
    readonly languageProfileId: string;
    readonly source: {
      readonly byteLength: number;
      readonly canonicalUri: string;
      readonly id: string;
      readonly sourceId: string;
    };
  };
};
export type WorkbenchLearnSourceMutation = {
  response: WorkbenchLearnSourceMutation$data;
  variables: WorkbenchLearnSourceMutation$variables;
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
    "concreteType": "LearnSourcePayload",
    "kind": "LinkedField",
    "name": "learnSource",
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
        "name": "evidenceId",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "languageProfileId",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "SourceVersion",
        "kind": "LinkedField",
        "name": "source",
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
            "name": "sourceId",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "canonicalUri",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "byteLength",
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
    "name": "WorkbenchLearnSourceMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "WorkbenchLearnSourceMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "8d5a3031ef160ffb01a03cb42d5eb741",
    "id": null,
    "metadata": {},
    "name": "WorkbenchLearnSourceMutation",
    "operationKind": "mutation",
    "text": "mutation WorkbenchLearnSourceMutation(\n  $input: LearnSourceInput!\n) {\n  learnSource(input: $input) {\n    clientMutationId\n    evidenceId\n    languageProfileId\n    source {\n      id\n      sourceId\n      canonicalUri\n      byteLength\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "ef64121c671a643632e0c01f0e4a8e65";

export default node;
