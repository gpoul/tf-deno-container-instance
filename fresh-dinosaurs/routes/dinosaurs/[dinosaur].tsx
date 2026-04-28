import { page } from "fresh";
import type { NoSQLClient } from "oracle-nosqldb";
import { LinkButton } from "../../components/LinkButton.tsx";
import {
  createClient,
  createQueryOptions,
  getConfiguredTableName,
  installNoSqlRetryFallback,
} from "../../scripts/load-db.ts";
import { define } from "../../utils.ts";

type DinosaurDetails = {
  name: string;
  description: string;
};

type DinosaurRow = {
  name?: unknown;
  description?: unknown;
};

type PageData = {
  dinosaur?: DinosaurDetails;
  error?: string;
};

let clientInfoPromise:
  | Promise<{ client: NoSQLClient; compartment?: string }>
  | undefined;

function getTableName(): string {
  return getConfiguredTableName();
}

function getConfigFile(): string | undefined {
  return Deno.env.get("NOSQL_CONFIG_FILE") ?? undefined;
}

async function getClientInfo(): Promise<{
  client: NoSQLClient;
  compartment?: string;
}> {
  installNoSqlRetryFallback();
  clientInfoPromise ??= createClient(getConfigFile());

  try {
    return await clientInfoPromise;
  } catch (error) {
    clientInfoPromise = undefined;
    throw error;
  }
}

function toDinosaur(row: DinosaurRow, index: number): DinosaurDetails {
  if (typeof row.name !== "string" || row.name.trim() === "") {
    throw new Error(`Oracle NoSQL row ${index} is missing a non-empty name`);
  }

  return {
    name: row.name,
    description: typeof row.description === "string" ? row.description : "",
  };
}

async function loadDinosaur(
  slug: string,
): Promise<DinosaurDetails | undefined> {
  const tableName = getTableName();
  const { client, compartment } = await getClientInfo();
  const queryOptions = await createQueryOptions(compartment);
  const normalizedSlug = slug.toLowerCase();
  let index = 0;

  for await (
    const result of client.queryIterable<DinosaurRow>(
      `SELECT name, description FROM ${tableName}`,
      queryOptions,
    )
  ) {
    for (const row of result.rows) {
      const dinosaur = toDinosaur(row, index++);
      if (dinosaur.name.toLowerCase() === normalizedSlug) {
        return dinosaur;
      }
    }
  }

  return undefined;
}

export const handler = define.handlers<PageData>({
  async GET(ctx) {
    try {
      const slug = decodeURIComponent(ctx.params.dinosaur);
      const dinosaur = await loadDinosaur(slug);

      if (!dinosaur) {
        return page({}, { status: 404 });
      }

      return page({ dinosaur });
    } catch (error) {
      console.error(error);
      return page(
        { error: "Unable to load dinosaur data from Oracle NoSQL." },
        { status: 500 },
      );
    }
  },
});

export default define.page<typeof handler>(function DinosaurPage({ data }) {
  if (data.error) {
    return (
      <main>
        <h1>Dinosaur not found</h1>
        <p>{data.error}</p>
        <LinkButton href="/" class="btn-secondary">← Back to list</LinkButton>
      </main>
    );
  }

  if (!data.dinosaur) {
    return (
      <main>
        <h1>Dinosaur not found</h1>
        <LinkButton href="/" class="btn-secondary">← Back to list</LinkButton>
      </main>
    );
  }

  return (
    <main>
      <h1>{data.dinosaur.name}</h1>
      <p>{data.dinosaur.description}</p>
      <LinkButton href="/" class="btn-secondary">← Back to list</LinkButton>
    </main>
  );
});
