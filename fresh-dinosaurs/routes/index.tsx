import { page } from "fresh";
import { Head } from "fresh/runtime";
import type { NoSQLClient } from "oracle-nosqldb";
import { define } from "../utils.ts";
import { LinkButton } from "../components/LinkButton.tsx";
import {
  createClient,
  createQueryOptions,
  getConfiguredTableName,
  installNoSqlRetryFallback,
} from "../scripts/load-db.ts";

type DinosaurSummary = {
  name: string;
  description: string;
};

type DinosaurRow = {
  name?: unknown;
  description?: unknown;
};

type PageData = {
  dinosaurs: DinosaurSummary[];
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

function toDinosaur(row: DinosaurRow, index: number): DinosaurSummary {
  if (typeof row.name !== "string" || row.name.trim() === "") {
    throw new Error(`Oracle NoSQL row ${index} is missing a non-empty name`);
  }

  return {
    name: row.name,
    description: typeof row.description === "string" ? row.description : "",
  };
}

async function loadDinosaurs(): Promise<DinosaurSummary[]> {
  const tableName = getTableName();
  const { client, compartment } = await getClientInfo();
  const queryOptions = await createQueryOptions(compartment);
  const dinosaurs: DinosaurSummary[] = [];
  let index = 0;

  for await (
    const result of client.queryIterable<DinosaurRow>(
      `SELECT name, description FROM ${tableName}`,
      queryOptions,
    )
  ) {
    for (const row of result.rows) {
      dinosaurs.push(toDinosaur(row, index++));
    }
  }

  return dinosaurs.toSorted((left, right) =>
    left.name.localeCompare(right.name)
  );
}

export const handler = define.handlers<PageData>({
  async GET() {
    try {
      return page({ dinosaurs: await loadDinosaurs() });
    } catch (error) {
      console.error(error);
      return page(
        {
          dinosaurs: [],
          error: "Unable to load dinosaur data from Oracle NoSQL.",
        },
        { status: 500 },
      );
    }
  },
});

export default define.page<typeof handler>(function Home({ data }) {
  return (
    <>
      <Head>
        <title>Dinosaur Encyclopedia</title>
      </Head>
      <main>
        <h1>🦕 Welcome to the Dinosaur Encyclopedia</h1>
        <p>Click on a dinosaur below to learn more.</p>
        {data.error && <p>{data.error}</p>}
        <div class="dinosaur-list">
          {data.dinosaurs.map((dinosaur) => (
            <LinkButton
              href={`/dinosaurs/${dinosaur.name.toLowerCase()}`}
              class="btn-primary"
            >
              {dinosaur.name}
            </LinkButton>
          ))}
        </div>
      </main>
    </>
  );
});
