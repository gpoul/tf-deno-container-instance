import type {
  NoSQLClient as NoSQLClientType,
  QueryOpt,
  TableLimits,
} from "oracle-nosqldb";

type DinosaurRecord = Record<string, unknown> & {
  name: string;
  description?: string;
};

type LoaderOptions = {
  configFile?: string;
  dataPath: string;
  skipTableCreate: boolean;
  tableName: string;
};

type ClientInfo = {
  client: NoSQLClientType;
  compartment?: string;
};

export const DEFAULT_TABLE_NAME = "dinosaurs";
const DEFAULT_DATA_PATH = new URL("../data.json", import.meta.url).pathname;
const DEFAULT_OCI_PROFILE = "DEFAULT";
const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_DDL_TIMEOUT = 10_000;
const DEFAULT_TABLE_READY_TIMEOUT = 120_000;
const DEFAULT_IAM_AUTH_TIMEOUT = 120_000;
const DEFAULT_POLL_DELAY = 1_000;
const DEFAULT_MAX_MEMORY_MB = 1_024;
const DEFAULT_SECURITY_TOKEN_REFRESH_AHEAD_MS = 15_000;
const DEFAULT_SECURITY_TOKEN_EXPIRE_BEFORE_MS = 10_000;
const DEFAULT_STORAGE_GB = 1;
const RETRY_FALLBACK = Object.freeze({
  handler: Object.freeze({
    doRetry: () => false,
    delay: () => 0,
  }),
});
let noSqlModulePromise: Promise<typeof import("oracle-nosqldb")> | undefined;

function getNoSqlModule(): Promise<typeof import("oracle-nosqldb")> {
  noSqlModulePromise ??= import(/* @vite-ignore */ "oracle-nosqldb");
  return noSqlModulePromise;
}

function printUsage(): void {
  console.log(`Load dinosaur records from ../data.json into Oracle NoSQL.

Usage:
  deno run -A scripts/load-db.ts [--config path/to/nosql-config.json] [--table dinosaurs] [--data ../data.json] [--skip-table-create]

Options:
  --config   Oracle NoSQL SDK config file path. Overrides env-based client config.
  --table    Target table name. Defaults to "${DEFAULT_TABLE_NAME}".
  --data     JSON file to load. Defaults to "../data.json".
  --skip-table-create
             Skip CREATE TABLE and only upsert rows into an existing table.
  --help     Show this help text.

Environment fallback when --config is not provided:
  NOSQL_CONFIG_FILE       Oracle NoSQL SDK config file path
  NOSQL_SERVICE_TYPE      "cloudsim" or "kvstore"
  NOSQL_ENDPOINT          Service endpoint such as "localhost:8080"
  NOSQL_REGION            OCI region override
  OCI_REGION              Secondary OCI region override
  NOSQL_COMPARTMENT_OCID  Optional cloud compartment OCID
  NOSQL_COMPARTMENT       Secondary cloud compartment override
  NOSQL_COMPARTMENT_ID    Secondary cloud compartment override
  OCI_COMPARTMENT_ID      Secondary cloud compartment override
  TF_VAR_compartment_ocid Terraform-style cloud compartment override
  NOSQL_OCI_CONFIG_FILE   OCI config file path, defaults to ~/.oci/config
  OCI_CLI_CONFIG_FILE     Secondary OCI config file override
  NOSQL_OCI_PROFILE       OCI profile, defaults to DEFAULT
  OCI_CLI_PROFILE         Secondary OCI profile override
  NOSQL_OCI_PRIVATE_KEY   PEM private key content for OCI user auth
  OCI_PRIVATE_KEY         Secondary PEM private key content override
  TF_VAR_private_key      Terraform-style PEM private key content override
  NOSQL_AUTH              Set to "resource-principal" or "cloud-shell" to force that auth mode
  NOSQL_USE_CLOUD_SHELL_AUTH
                          Force OCI Cloud Shell delegation-token auth when set to true/1/yes
  NOSQL_OCI_DELEGATION_TOKEN_FILE
                          Delegation token file override for Cloud Shell auth
  NOSQL_USE_RESOURCE_PRINCIPAL
                          Force OCI Resource Principal auth when set to true/1/yes
  NOSQL_USE_RESOURCE_PRINCIPAL_COMPARTMENT
                          Use the OCI resource's compartment for NoSQL operations
  NOSQL_OCI_TENANT_ID     Optional tenancy OCID when not using OCI config
  NOSQL_OCI_USER_ID       Optional user OCID when not using OCI config
  NOSQL_OCI_FINGERPRINT   Optional public key fingerprint when not using OCI config
  NOSQL_TABLE_NAME        Default table name override
  NOSQL_TABLE             Secondary default table name override
  NOSQL_DATA_FILE         Default data file override
  NOSQL_SKIP_TABLE_CREATE Skip CREATE TABLE when set to true/1/yes
  NOSQL_STORAGE_GB        On-demand table storage limit for create, defaults to ${DEFAULT_STORAGE_GB}
`);
}

function parseArgs(args: string[]): LoaderOptions {
  let configFile = Deno.env.get("NOSQL_CONFIG_FILE") ?? undefined;
  let dataPath = Deno.env.get("NOSQL_DATA_FILE") ?? DEFAULT_DATA_PATH;
  let skipTableCreate = parseBooleanEnv("NOSQL_SKIP_TABLE_CREATE");
  let tableName = getConfiguredTableName();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      Deno.exit(0);
    }

    if (arg === "--config") {
      configFile = requireValue(args, ++index, "--config");
      continue;
    }

    if (arg === "--data") {
      dataPath = requireValue(args, ++index, "--data");
      continue;
    }

    if (arg === "--table") {
      tableName = requireValue(args, ++index, "--table");
      continue;
    }

    if (arg === "--skip-table-create") {
      skipTableCreate = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  validateTableName(tableName);

  return {
    configFile,
    dataPath: resolvePath(dataPath),
    skipTableCreate,
    tableName,
  };
}

function parseBooleanEnv(name: string): boolean {
  const value = Deno.env.get(name)?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function resolvePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${Deno.cwd()}/${path}`;
}

export function validateTableName(tableName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(
      `Invalid table name "${tableName}". Use letters, numbers, and underscores only.`,
    );
  }
}

export function getConfiguredTableName(): string {
  const tableName = firstEnv("NOSQL_TABLE_NAME", "NOSQL_TABLE") ??
    DEFAULT_TABLE_NAME;
  validateTableName(tableName);
  return tableName;
}

function parsePositiveInt(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function getTableStorageGB(): number {
  return parsePositiveInt(
    "NOSQL_STORAGE_GB",
    Deno.env.get("NOSQL_STORAGE_GB") ?? undefined,
  ) ?? DEFAULT_STORAGE_GB;
}

function createBaseConfig(): Record<string, unknown> {
  return {
    timeout: DEFAULT_TIMEOUT,
    ddlTimeout: DEFAULT_DDL_TIMEOUT,
    securityInfoTimeout: DEFAULT_DDL_TIMEOUT,
    tablePollTimeout: Infinity,
    tablePollDelay: DEFAULT_POLL_DELAY,
    adminPollTimeout: Infinity,
    adminPollDelay: DEFAULT_POLL_DELAY,
    consistency: "EVENTUAL",
    maxMemoryMB: DEFAULT_MAX_MEMORY_MB,
    retry: {
      handler: {
        doRetry: () => false,
        delay: () => 0,
      },
    },
  };
}

export function installNoSqlRetryFallback(): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "retry");
  if (descriptor && !descriptor.configurable) {
    return;
  }

  // Deno's Node compatibility path can leave oracle-nosqldb request options
  // without inherited retry defaults. Keep this non-enumerable so SDK option
  // validation does not see it as an explicit override.
  Object.defineProperty(Object.prototype, "retry", {
    configurable: true,
    value: RETRY_FALLBACK,
    writable: true,
  });
}

type OciProfile = {
  tenancy?: string;
  user?: string;
  fingerprint?: string;
  key_file?: string;
  pass_phrase?: string;
  region?: string;
  compartment?: string;
  delegation_token_file?: string;
};

type CloudTarget = {
  authMode:
    | "cloud-shell"
    | "iam-profile"
    | "iam-private-key"
    | "resource-principal"
    | "default";
  compartment?: string;
  profileName?: string;
  region?: string;
  delegationTokenFile?: string;
  useResourcePrincipalCompartment?: boolean;
};

function expandHome(path: string): string {
  if (path === "~") {
    return Deno.env.get("HOME") ?? path;
  }

  if (path.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    return home ? `${home}${path.slice(1)}` : path;
  }

  return path;
}

function getDefaultOciConfigFile(): string | undefined {
  const home = Deno.env.get("HOME");
  return home ? `${home}/.oci/config` : undefined;
}

function parseOciConfig(text: string): Record<string, OciProfile> {
  const profiles: Record<string, OciProfile> = {};
  let currentProfile = DEFAULT_OCI_PROFILE;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentProfile = sectionMatch[1].trim();
      profiles[currentProfile] ??= {};
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    profiles[currentProfile] ??= {};
    profiles[currentProfile][key as keyof OciProfile] = value;
  }

  return profiles;
}

function readOciProfile(
  configFile: string | undefined,
  profileName: string,
): OciProfile {
  if (!configFile) {
    return {};
  }

  try {
    const profiles = parseOciConfig(
      Deno.readTextFileSync(expandHome(configFile)),
    );
    return profiles[profileName] ?? {};
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }
    throw error;
  }
}

function normalizePrivateKey(privateKey: string): string {
  const normalized = privateKey
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n")
    .trim();
  const pemMatch = normalized.match(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  );
  if (pemMatch) {
    return `${pemMatch[0]}\n`;
  }

  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function isLegacyEncryptedPrivateKey(privateKey: string): boolean {
  return privateKey.includes("-----BEGIN RSA PRIVATE KEY-----") &&
    privateKey.includes("Proc-Type: 4,ENCRYPTED");
}

function isEncryptedPrivateKey(privateKey: string): boolean {
  return privateKey.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----") ||
    isLegacyEncryptedPrivateKey(privateKey);
}

async function decryptPrivateKey(
  privateKey: string,
  passphrase: string | undefined,
): Promise<string> {
  if (!isLegacyEncryptedPrivateKey(privateKey)) {
    return privateKey;
  }

  if (!passphrase) {
    throw new Error(
      "TF_VAR_private_key contains a legacy encrypted RSA private key. " +
        "Set NOSQL_OCI_PASSPHRASE, OCI_PASSPHRASE, or TF_VAR_private_key_passphrase so the loader can decrypt it with openssl.",
    );
  }

  const command = new Deno.Command("openssl", {
    args: ["rsa", "-passin", "env:NOSQL_OCI_OPENSSL_PASSPHRASE"],
    env: {
      NOSQL_OCI_OPENSSL_PASSPHRASE: passphrase,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(privateKey));
  await writer.close();

  const output = await child.output();
  if (!output.success) {
    const error = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `Unable to decrypt OCI private key with openssl: ${
        error || `exit code ${output.code}`
      }`,
    );
  }

  return normalizePrivateKey(new TextDecoder().decode(output.stdout));
}

function getEnvPrivateKey(): string | undefined {
  const privateKey = Deno.env.get("NOSQL_OCI_PRIVATE_KEY") ??
    Deno.env.get("OCI_PRIVATE_KEY") ??
    Deno.env.get("TF_VAR_private_key");
  if (privateKey) {
    return normalizePrivateKey(privateKey);
  }

  const base64PrivateKey = Deno.env.get("NOSQL_OCI_PRIVATE_KEY_B64") ??
    Deno.env.get("OCI_PRIVATE_KEY_B64") ??
    Deno.env.get("TF_VAR_private_key_base64");
  if (!base64PrivateKey) {
    return undefined;
  }

  return normalizePrivateKey(atob(base64PrivateKey));
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function isResourcePrincipalAuthRequested(): boolean {
  const auth = Deno.env.get("NOSQL_AUTH")?.trim().toLowerCase();
  if (
    auth === "resource-principal" ||
    auth === "resource_principal" ||
    auth === "resourceprincipal"
  ) {
    return true;
  }

  return parseBooleanEnv("NOSQL_USE_RESOURCE_PRINCIPAL") ||
    parseBooleanEnv("OCI_USE_RESOURCE_PRINCIPAL") ||
    Deno.env.get("OCI_RESOURCE_PRINCIPAL_VERSION") !== undefined;
}

function isCloudShellAuthRequested(): boolean {
  const auth = Deno.env.get("NOSQL_AUTH")?.trim().toLowerCase();
  if (
    auth === "cloud-shell" ||
    auth === "cloud_shell" ||
    auth === "cloudshell" ||
    auth === "instance-obo-user" ||
    auth === "instance_obo_user" ||
    auth === "instanceobouser"
  ) {
    return true;
  }

  const cliAuth = Deno.env.get("OCI_CLI_AUTH")?.trim().toLowerCase();
  return parseBooleanEnv("NOSQL_USE_CLOUD_SHELL_AUTH") ||
    cliAuth === "instance_obo_user" ||
    cliAuth === "instance-obo-user";
}

function isResourcePrincipalCompartmentRequested(): boolean {
  return parseBooleanEnv("NOSQL_USE_RESOURCE_PRINCIPAL_COMPARTMENT") ||
    parseBooleanEnv("OCI_USE_RESOURCE_PRINCIPAL_COMPARTMENT");
}

function logCloudTarget(target: CloudTarget): void {
  const profile = target.profileName ? `, profile=${target.profileName}` : "";
  const resourceCompartment = target.useResourcePrincipalCompartment
    ? ", resourceCompartment=true"
    : "";
  const delegationToken = target.delegationTokenFile
    ? `, delegationTokenFile=${target.delegationTokenFile}`
    : "";
  console.log(
    `Oracle NoSQL target: auth=${target.authMode}${profile}, region=${
      target.region ?? "(SDK default)"
    }, compartment=${
      target.compartment ?? "(SDK default/root)"
    }${resourceCompartment}${delegationToken}`,
  );
}

function shortValue(value: string): string {
  return value.length <= 18
    ? value
    : `${value.slice(0, 12)}...${value.slice(-8)}`;
}

export async function createClient(configFile?: string): Promise<ClientInfo> {
  const { NoSQLClient } = await getNoSqlModule();

  if (configFile) {
    console.log(`Oracle NoSQL target: configFile=${configFile}`);
    return { client: new NoSQLClient(configFile) };
  }

  const endpoint = Deno.env.get("NOSQL_ENDPOINT") ?? undefined;
  const serviceType = Deno.env.get("NOSQL_SERVICE_TYPE")?.toLowerCase();
  if (serviceType || endpoint) {
    if (!serviceType || !endpoint) {
      throw new Error(
        "NOSQL_SERVICE_TYPE and NOSQL_ENDPOINT must be set together for cloudsim/kvstore access.",
      );
    }

    if (serviceType === "cloudsim") {
      return {
        client: new NoSQLClient({
          ...createBaseConfig(),
          serviceType: "CLOUDSIM",
          endpoint,
        }),
      };
    }

    if (serviceType === "kvstore") {
      return {
        client: new NoSQLClient({
          ...createBaseConfig(),
          serviceType: "KVSTORE",
          endpoint,
        }),
      };
    }

    throw new Error(
      `Unsupported NOSQL_SERVICE_TYPE "${serviceType}". Use "cloudsim" or "kvstore".`,
    );
  }

  const region = firstEnv("NOSQL_REGION", "OCI_REGION");
  const compartment = firstEnv(
    "NOSQL_COMPARTMENT_OCID",
    "NOSQL_COMPARTMENT",
    "NOSQL_COMPARTMENT_ID",
    "OCI_COMPARTMENT_ID",
    "OCI_COMPARTMENT_OCID",
    "TF_VAR_compartment_ocid",
    "TF_VAR_compartment_id",
  );
  const ociConfigFile = Deno.env.get("NOSQL_OCI_CONFIG_FILE") ??
    Deno.env.get("OCI_CLI_CONFIG_FILE") ??
    undefined;
  const ociProfile = Deno.env.get("NOSQL_OCI_PROFILE") ??
    Deno.env.get("OCI_CLI_PROFILE") ??
    undefined;
  const profileName = ociProfile ?? DEFAULT_OCI_PROFILE;
  const privateKey = getEnvPrivateKey();
  const shouldUseResourcePrincipal = isResourcePrincipalAuthRequested();
  const shouldUseCloudShellAuth = isCloudShellAuthRequested();
  const shouldUseResourcePrincipalCompartment =
    isResourcePrincipalCompartmentRequested();

  const cloudConfig: Record<string, unknown> = {
    ...createBaseConfig(),
    serviceType: "CLOUD",
  };

  const profile = privateKey || shouldUseCloudShellAuth
    ? readOciProfile(ociConfigFile ?? getDefaultOciConfigFile(), profileName)
    : {};
  const passphrase = firstEnv(
    "NOSQL_OCI_PASSPHRASE",
    "OCI_PASSPHRASE",
    "TF_VAR_private_key_passphrase",
  ) ?? profile.pass_phrase;

  if (region) {
    cloudConfig.region = region;
  } else if (profile.region) {
    cloudConfig.region = profile.region;
  }
  if (compartment) {
    cloudConfig.compartment = compartment;
  } else if (profile.compartment) {
    cloudConfig.compartment = profile.compartment;
  }

  if (shouldUseResourcePrincipal) {
    if (!cloudConfig.compartment && !shouldUseResourcePrincipalCompartment) {
      throw new Error(
        "OCI Resource Principal auth needs a NoSQL compartment OCID. " +
          "Set NOSQL_COMPARTMENT_ID/TF_VAR_compartment_ocid or set " +
          "NOSQL_USE_RESOURCE_PRINCIPAL_COMPARTMENT=true to use the OCI resource's compartment.",
      );
    }

    cloudConfig.auth = {
      iam: {
        useResourcePrincipal: true,
        securityTokenRefreshAheadMs: DEFAULT_SECURITY_TOKEN_REFRESH_AHEAD_MS,
        securityTokenExpireBeforeMs: DEFAULT_SECURITY_TOKEN_EXPIRE_BEFORE_MS,
        ...(shouldUseResourcePrincipalCompartment
          ? { useResourcePrincipalCompartment: true }
          : {}),
      },
    };
    logCloudTarget({
      authMode: "resource-principal",
      region: cloudConfig.region as string | undefined,
      compartment: cloudConfig.compartment as string | undefined,
      useResourcePrincipalCompartment: shouldUseResourcePrincipalCompartment,
    });
  } else if (shouldUseCloudShellAuth) {
    const delegationTokenFile = firstEnv(
      "NOSQL_OCI_DELEGATION_TOKEN_FILE",
      "OCI_DELEGATION_TOKEN_FILE",
    ) ?? profile.delegation_token_file;

    if (!delegationTokenFile) {
      throw new Error(
        "OCI Cloud Shell auth needs a delegation token file. " +
          "Run from Cloud Shell with OCI_CLI_CONFIG_FILE/OCI_CLI_PROFILE set, or set NOSQL_OCI_DELEGATION_TOKEN_FILE.",
      );
    }

    cloudConfig.auth = {
      iam: {
        useInstancePrincipal: true,
        delegationTokenFile: expandHome(delegationTokenFile),
        timeout: DEFAULT_IAM_AUTH_TIMEOUT,
        securityTokenRefreshAheadMs: DEFAULT_SECURITY_TOKEN_REFRESH_AHEAD_MS,
        securityTokenExpireBeforeMs: DEFAULT_SECURITY_TOKEN_EXPIRE_BEFORE_MS,
      },
    };
    logCloudTarget({
      authMode: "cloud-shell",
      profileName,
      region: cloudConfig.region as string | undefined,
      compartment: cloudConfig.compartment as string | undefined,
      delegationTokenFile,
    });
  } else if (privateKey) {
    const tenantId = firstEnv(
      "NOSQL_OCI_TENANT_ID",
      "OCI_TENANCY",
      "OCI_TENANCY_OCID",
      "TF_VAR_tenancy_ocid",
    ) ?? profile.tenancy;
    const userId = firstEnv(
      "NOSQL_OCI_USER_ID",
      "OCI_USER",
      "OCI_USER_OCID",
      "TF_VAR_user_ocid",
    ) ?? profile.user;
    const fingerprint = firstEnv(
      "NOSQL_OCI_FINGERPRINT",
      "OCI_FINGERPRINT",
      "TF_VAR_fingerprint",
    ) ?? profile.fingerprint;
    const decryptedPrivateKey = await decryptPrivateKey(privateKey, passphrase);

    const missingFields = [
      tenantId ? undefined : "tenancy",
      userId ? undefined : "user",
      fingerprint ? undefined : "fingerprint",
    ].filter(Boolean);
    if (missingFields.length > 0) {
      throw new Error(
        `Missing OCI ${missingFields.join(", ")} for env private key auth. ` +
          "Set NOSQL_OCI_TENANT_ID, NOSQL_OCI_USER_ID, and NOSQL_OCI_FINGERPRINT or provide them in the selected OCI config profile.",
      );
    }
    const resolvedTenantId = tenantId as string;
    const resolvedUserId = userId as string;
    const resolvedFingerprint = fingerprint as string;

    cloudConfig.auth = {
      iam: {
        tenantId: resolvedTenantId,
        userId: resolvedUserId,
        fingerprint: resolvedFingerprint,
        privateKey: decryptedPrivateKey,
        ...(decryptedPrivateKey === privateKey &&
            isEncryptedPrivateKey(privateKey) &&
            passphrase
          ? { passphrase }
          : {}),
      },
    };
    console.log(
      `OCI identity: tenancy=${shortValue(resolvedTenantId)}, user=${
        shortValue(resolvedUserId)
      }, fingerprint=${resolvedFingerprint}`,
    );
    logCloudTarget({
      authMode: "iam-private-key",
      profileName,
      region: cloudConfig.region as string | undefined,
      compartment: cloudConfig.compartment as string | undefined,
    });
  } else if (ociConfigFile || ociProfile) {
    cloudConfig.auth = {
      iam: {
        ...(ociConfigFile ? { configFile: ociConfigFile } : {}),
        profileName,
      },
    };
    logCloudTarget({
      authMode: "iam-profile",
      profileName,
      region: cloudConfig.region as string | undefined,
      compartment: cloudConfig.compartment as string | undefined,
    });
  } else {
    logCloudTarget({
      authMode: "default",
      profileName,
      region: cloudConfig.region as string | undefined,
      compartment: cloudConfig.compartment as string | undefined,
    });
  }

  return {
    client: new NoSQLClient(cloudConfig),
    compartment: cloudConfig.compartment as string | undefined,
  };
}

async function readDinosaurs(dataPath: string): Promise<DinosaurRecord[]> {
  const text = await Deno.readTextFile(dataPath);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array of dinosaur records in ${dataPath}`);
  }

  const seenNames = new Set<string>();
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Record ${index} is not a JSON object`);
    }

    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.trim() === "") {
      throw new Error(`Record ${index} is missing a non-empty "name"`);
    }

    if (
      record.description !== undefined &&
      typeof record.description !== "string"
    ) {
      throw new Error(`Record ${index} has a non-string "description"`);
    }

    if (seenNames.has(record.name)) {
      throw new Error(
        `Duplicate dinosaur name "${record.name}" found in ${dataPath}`,
      );
    }
    seenNames.add(record.name);

    return record as DinosaurRecord;
  });
}

function buildRow(record: DinosaurRecord): Record<string, unknown> {
  const { name, description, ...details } = record;
  const row: Record<string, unknown> = { name };

  if (typeof description === "string") {
    row.description = description;
  }

  if (Object.keys(details).length > 0) {
    row.details = details;
  }

  return row;
}

export function createOperationOptions(
  compartment: string | undefined,
): { compartment?: string; timeout: number } {
  return {
    ...(compartment ? { compartment } : {}),
    timeout: DEFAULT_TIMEOUT,
  };
}

export async function createQueryOptions(
  compartment: string | undefined,
): Promise<QueryOpt> {
  const { Consistency } = await getNoSqlModule();
  return {
    ...createOperationOptions(compartment),
    consistency: Consistency.EVENTUAL,
  };
}

function isRetryableTablePollError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("SECURITY_INFO_UNAVAILABLE") ||
    error.message.includes("NotAuthenticated") ||
    error.message.includes("NETWORK_ERROR");
}

async function ensureTable(
  client: NoSQLClientType,
  tableName: string,
  storageGB: number,
  compartment?: string,
): Promise<void> {
  const { CapacityMode, TableState } = await getNoSqlModule();
  const ddl =
    `CREATE TABLE IF NOT EXISTS ${tableName} (name STRING, description STRING, details JSON, PRIMARY KEY(name))`;
  const tableLimits: TableLimits = {
    storageGB,
    mode: CapacityMode.ON_DEMAND,
  };

  console.log(
    `Using on-demand table capacity: storageGB=${tableLimits.storageGB}`,
  );
  const opOptions = createOperationOptions(compartment);
  await client.tableDDL(ddl, { ...opOptions, tableLimits });

  console.log(`Submitted table DDL for "${tableName}"`);
  const deadline = Date.now() + DEFAULT_TABLE_READY_TIMEOUT;
  for (;;) {
    try {
      const table = await client.getTable(tableName, opOptions);
      if (table.tableState === TableState.ACTIVE) {
        console.log(`Table "${tableName}" is active`);
        return;
      }
      if (
        table.tableState === TableState.DROPPED ||
        table.tableState === TableState.DROPPING
      ) {
        throw new Error(`Table "${tableName}" is in state ${table.tableState}`);
      }

      console.log(`Table "${tableName}" is ${table.tableState}; waiting`);
    } catch (error) {
      if (!isRetryableTablePollError(error) || Date.now() >= deadline) {
        throw error;
      }

      console.log(`Table "${tableName}" status is not ready yet; waiting`);
    }

    await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_DELAY));
  }
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);
  const dinosaurs = await readDinosaurs(options.dataPath);
  const storageGB = getTableStorageGB();
  console.log("Creating Oracle NoSQL client");
  const { client, compartment } = await createClient(options.configFile);
  installNoSqlRetryFallback();

  try {
    if (options.skipTableCreate) {
      console.log(`Skipping table creation for "${options.tableName}"`);
    } else {
      console.log(`Ensuring table "${options.tableName}" exists`);
      await ensureTable(client, options.tableName, storageGB, compartment);
    }

    for (const dinosaur of dinosaurs) {
      console.log(`Upserting "${dinosaur.name}"`);
      await client.put(
        options.tableName,
        buildRow(dinosaur),
        createOperationOptions(compartment),
      );
    }

    console.log(
      `Loaded ${dinosaurs.length} dinosaur records into table "${options.tableName}" from ${options.dataPath}`,
    );
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.stack ?? error.message);
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause instanceof Error) {
        console.error("Caused by:");
        console.error(cause.stack ?? cause.message);
      } else if (cause !== undefined) {
        console.error("Caused by:", cause);
      }
    } else {
      console.error(String(error));
    }
    Deno.exit(1);
  }
}
