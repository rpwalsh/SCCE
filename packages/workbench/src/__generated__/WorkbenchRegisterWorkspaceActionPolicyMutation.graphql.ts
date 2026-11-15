/**
 * @generated SignedSource<<2f67e52c86311e017fac7b7ba9810e88>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type RegisterWorkspaceActionPolicyInput = {
  clientMutationId?: string | null | undefined;
  expectedWorkspaceUpdatedAt: number;
  operationId: string;
  policy: WorkspaceActionPolicyInput;
  workspaceId: string;
};
export type WorkspaceActionPolicyInput = {
  capabilityIds: ReadonlyArray<string>;
  checks: ReadonlyArray<WorkspaceActionCheckInput>;
  maxCalls: number;
  maxFileBytes: number;
  maxOutputBytes: number;
  maxWorkspaceBytes: number;
  maxWorkspaceFiles: number;
  protectedFiles: ReadonlyArray<WorkspaceActionProtectedFileInput>;
  readablePaths: ReadonlyArray<string>;
  schema: string;
  timeoutMs: number;
  writablePaths: ReadonlyArray<string>;
};
export type WorkspaceActionProtectedFileInput = {
  path: string;
  sha256: string;
};
export type WorkspaceActionCheckInput = {
  argv: ReadonlyArray<string>;
  cwd: string;
  executable: string;
  executableSha256: string;
};
export type WorkbenchRegisterWorkspaceActionPolicyMutation$variables = {
  input: RegisterWorkspaceActionPolicyInput;
};
export type WorkbenchRegisterWorkspaceActionPolicyMutation$data = {
  readonly registerWorkspaceActionPolicy: {
    readonly clientMutationId: string | null | undefined;
    readonly workspaceActionContext: {
      readonly expectedWorkspaceUpdatedAt: number;
      readonly policyId: string;
      readonly schema: string;
      readonly workspaceId: string;
    };
  };
};
export type WorkbenchRegisterWorkspaceActionPolicyMutation = {
  response: WorkbenchRegisterWorkspaceActionPolicyMutation$data;
  variables: WorkbenchRegisterWorkspaceActionPolicyMutation$variables;
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
    "concreteType": "RegisterWorkspaceActionPolicyPayload",
    "kind": "LinkedField",
    "name": "registerWorkspaceActionPolicy",
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
        "concreteType": "WorkspaceActionContext",
        "kind": "LinkedField",
        "name": "workspaceActionContext",
        "plural": false,
        "selections": [
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
            "kind": "ScalarField",
            "name": "workspaceId",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "expectedWorkspaceUpdatedAt",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "policyId",
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
    "name": "WorkbenchRegisterWorkspaceActionPolicyMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "WorkbenchRegisterWorkspaceActionPolicyMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "c7781584d67f108a0861df26925b35b1",
    "id": null,
    "metadata": {},
    "name": "WorkbenchRegisterWorkspaceActionPolicyMutation",
    "operationKind": "mutation",
    "text": "mutation WorkbenchRegisterWorkspaceActionPolicyMutation(\n  $input: RegisterWorkspaceActionPolicyInput!\n) {\n  registerWorkspaceActionPolicy(input: $input) {\n    clientMutationId\n    workspaceActionContext {\n      schema\n      workspaceId\n      expectedWorkspaceUpdatedAt\n      policyId\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "88662a284157f2ff4e40d9a4b433d3fd";

export default node;
