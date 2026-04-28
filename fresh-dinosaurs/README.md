# Fresh project

Your new Fresh project is ready to go. You can follow the Fresh "Getting
Started" guide here: https://fresh.deno.dev/docs/getting-started

### Usage

Make sure to install Deno:
https://docs.deno.com/runtime/getting_started/installation

Then start the project in development mode:

```
deno task dev
```

This will watch the project directory and restart as necessary.

### Docker

Build the production image from this directory:

```
docker build -t fresh-dinosaurs .
```

Run it on port 8000; for Oracle NoSQL, pass the same environment variables used by the loader. For
example, when running locally with OCI user key auth:

```
docker run --rm -p 8000:8000 \
  -e NOSQL_REGION="eu-frankfurt-1" \
  -e TF_VAR_compartment_ocid="ocid1.compartment..." \
  -e TF_VAR_private_key="$TF_VAR_private_key" \
  -e NOSQL_OCI_TENANT_ID="ocid1.tenancy..." \
  -e NOSQL_OCI_USER_ID="ocid1.user..." \
  -e NOSQL_OCI_FINGERPRINT="aa:bb:cc:..." \
  fresh-dinosaurs
```

When running on OCI Container Instances, prefer Resource Principal auth instead
of shipping user credentials. The app auto-detects the
`OCI_RESOURCE_PRINCIPAL_*` variables injected by OCI, so the container only
needs the NoSQL table and compartment configuration:

```
NOSQL_TABLE_NAME=dinosaurs
NOSQL_COMPARTMENT_OCID=ocid1.compartment...
```

Alternatively, keep the tables in the container instance's own compartment and
let the SDK read that compartment from the resource principal session token:

```
NOSQL_TABLE_NAME=dinosaurs
NOSQL_USE_RESOURCE_PRINCIPAL_COMPARTMENT=true
```

You can also force Resource Principal auth explicitly with
`NOSQL_AUTH=resource-principal` or `NOSQL_USE_RESOURCE_PRINCIPAL=true`. For
compatibility, `NOSQL_TABLE`, `NOSQL_COMPARTMENT_ID`, and
`TF_VAR_compartment_ocid` are still supported as fallback aliases.

The container instance's dynamic group needs an IAM policy that allows it to use
NoSQL tables in the target compartment.

### Loading Oracle NoSQL data

The database loader can use an OCI config profile, or PEM key content supplied
through the environment. For encrypted OCI keys, decrypt the PEM into
`TF_VAR_private_key` before running the loader:

```
export TF_VAR_private_key="$(openssl rsa -in ~/.oci/oci_api_key.pem -check)"
deno task load-db
```

If `TF_VAR_private_key` contains the original encrypted `BEGIN RSA PRIVATE KEY`
content instead, also set the key passphrase. The loader will decrypt that
legacy PEM format with `openssl` before handing it to Deno:

```
export TF_VAR_private_key="$(cat ~/.oci/oci_api_key.pem)"
export TF_VAR_private_key_passphrase="your-passphrase"
deno task load-db
```

The loader reads tenancy, user, fingerprint, and region from `~/.oci/config` by
default. The NoSQL table compartment may also need to be set explicitly; if
`NOSQL_COMPARTMENT_OCID` is not set, the loader leaves the compartment unset and
uses the Oracle NoSQL SDK default/root behavior, which may not match the
compartment where your IAM policy allows table creation. You can provide all of
these values explicitly:

```
export NOSQL_OCI_TENANT_ID="ocid1.tenancy..."
export NOSQL_OCI_USER_ID="ocid1.user..."
export NOSQL_OCI_FINGERPRINT="aa:bb:cc:..."
export NOSQL_REGION="eu-frankfurt-1"
export NOSQL_COMPARTMENT_OCID="ocid1.compartment..."
deno task load-db
```

By default, new cloud tables are created with on-demand capacity and `1` GB
storage. Override the storage limit with `NOSQL_STORAGE_GB` if needed.

For comparison, the OCI CLI uses different table limit field names:

```
oci nosql table create \
  --region eu-frankfurt-1 \
  --compartment-id "$TF_VAR_compartment_ocid" \
  --name dinosaurs \
  --ddl-statement 'CREATE TABLE IF NOT EXISTS dinosaurs (name STRING, description STRING, details JSON, PRIMARY KEY(name))' \
  --table-limits '{"maxStorageInGBs": 1, "capacityMode": "ON_DEMAND"}'
```

If the table already exists, skip the DDL step and only load rows:

```
deno task load-db --skip-table-create
```

If table creation fails with `INSUFFICIENT_PERMISSION`, confirm the printed
region and compartment match the compartment where the user has Oracle NoSQL
table permissions.
