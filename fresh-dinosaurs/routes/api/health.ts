import {
  createClient,
  createOperationOptions,
  getConfiguredTableName,
  installNoSqlRetryFallback,
} from "../../scripts/load-db.ts";
import { define } from "../../utils.ts";

type HealthResponse = {
  ok: boolean;
  tableName: string;
  auth: {
    resourcePrincipalEnv: boolean;
    forcedResourcePrincipal: boolean;
    cloudShell: boolean;
    useResourcePrincipalCompartment: boolean;
  };
  config: {
    compartment: string | null;
    region: string | null;
  };
  nosql?: {
    ok: boolean;
    error?: string;
    cause?: string;
  };
};

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function parseBooleanEnv(name: string): boolean {
  const value = Deno.env.get(name)?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function mask(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  return value.length <= 18
    ? value
    : `${value.slice(0, 12)}...${value.slice(-8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  return cause === undefined ? undefined : errorMessage(cause);
}

export const handler = define.handlers({
  async GET() {
    const tableName = getConfiguredTableName();
    const compartment = firstEnv(
      "NOSQL_COMPARTMENT_OCID",
      "NOSQL_COMPARTMENT",
      "NOSQL_COMPARTMENT_ID",
      "OCI_COMPARTMENT_ID",
      "OCI_COMPARTMENT_OCID",
      "TF_VAR_compartment_ocid",
      "TF_VAR_compartment_id",
    );
    const response: HealthResponse = {
      ok: false,
      tableName,
      auth: {
        resourcePrincipalEnv:
          Deno.env.get("OCI_RESOURCE_PRINCIPAL_VERSION") !== undefined,
        forcedResourcePrincipal:
          parseBooleanEnv("NOSQL_USE_RESOURCE_PRINCIPAL") ||
          Deno.env.get("NOSQL_AUTH")?.trim().toLowerCase() ===
            "resource-principal",
        cloudShell: parseBooleanEnv("NOSQL_USE_CLOUD_SHELL_AUTH") ||
          Deno.env.get("OCI_CLI_AUTH")?.trim().toLowerCase() ===
            "instance_obo_user" ||
          [
            "cloud-shell",
            "cloud_shell",
            "cloudshell",
            "instance-obo-user",
            "instance_obo_user",
            "instanceobouser",
          ].includes(
            Deno.env.get("NOSQL_AUTH")?.trim().toLowerCase() ?? "",
          ),
        useResourcePrincipalCompartment: parseBooleanEnv(
          "NOSQL_USE_RESOURCE_PRINCIPAL_COMPARTMENT",
        ),
      },
      config: {
        compartment: mask(compartment),
        region: firstEnv(
          "NOSQL_REGION",
          "OCI_REGION",
          "OCI_CLI_REGION",
          "OCI_RESOURCE_PRINCIPAL_REGION",
        ) ??
          null,
      },
    };

    try {
      installNoSqlRetryFallback();
      const { client, compartment: clientCompartment } = await createClient();
      try {
        await client.getTable(
          tableName,
          createOperationOptions(clientCompartment),
        );
        response.ok = true;
        response.nosql = { ok: true };
      } finally {
        client.close();
      }
    } catch (error) {
      response.nosql = {
        ok: false,
        error: errorMessage(error),
        cause: errorCause(error),
      };
    }

    return Response.json(response, {
      status: response.ok ? 200 : 503,
      headers: {
        "cache-control": "no-store",
      },
    });
  },
});
