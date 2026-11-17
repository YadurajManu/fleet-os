import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { postgresEngine, redisEngine } from "../src/databases/engines.js";

async function run(command: string, args: string[], env = process.env) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString().trim())
        : reject(
            new Error(
              `Runtime fixture ${command} failed (${code}); private output withheld`,
            ),
          ),
    );
  });
}
const platform = `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`;
for (const engine of [postgresEngine, redisEngine])
  for (const version of engine.versions) {
    test(
      `durable runtime ${engine.engine} ${version}: receipt replay, lifecycle and private binary TCP`,
      { timeout: 180000 },
      async () => {
        const identity = {
          id: randomUUID(),
          nodeId: randomUUID(),
          fleetId: randomUUID(),
          project: "runtime-integration",
          generation: 1,
        };
        const imageId = async (tag: string) =>
          await run("docker", [
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            `fleet-db-build/${tag}`,
          ]);
        const plan = engine.plan({
          id: identity.id,
          fleetId: identity.fleetId,
          project: identity.project,
          name: "runtime",
          version,
          mode: engine.engine === "postgres" ? "standard" : "durable",
          allocation: { memoryMb: 512, diskMb: 10240 },
          credentials: engine.credentials(),
          images: {
            primary: await imageId(`${engine.engine}:${version}`),
            ...(engine.engine === "postgres"
              ? { pooler: await imageId("pgbouncer:1") }
              : {}),
          },
        });
        const volume = `fleet-db-${identity.id}-data`;
        try {
          const operation = {
            id: randomUUID(),
            action: "provision",
            identity,
            bootstrap: plan.bootstrap,
            readiness: plan.readiness,
            containers: plan.containers.map((container) => ({
              initialize: true,
              identity,
              network: plan.network,
              volume,
              dataPath: plan.dataPath,
              platform,
              cpu: 0.5,
              container,
            })),
          };
          const output = await run(
            "go",
            [
              "-C",
              "../agent",
              "test",
              "./internal/docker",
              "-run",
              "^TestDatabaseRuntimeRealDocker$",
              "-count=1",
              "-v",
            ],
            {
              ...process.env,
              FLEET_DB_RUNTIME_TEST: JSON.stringify(operation),
            },
          );
          assert.match(output, /--- PASS: TestDatabaseRuntimeRealDocker/);
          for (const container of plan.containers) {
            const [state] = JSON.parse(
              await run("docker", [
                "inspect",
                `fleet-db-${identity.id}-${container.role}`,
              ]),
            );
            assert.deepEqual(state.HostConfig.PortBindings ?? {}, {});
            assert.equal(state.Config.Labels["io.fleet.database"], identity.id);
          }
        } finally {
          const owned = await run("docker", [
            "ps",
            "-aq",
            "--filter",
            `label=io.fleet.database=${identity.id}`,
          ]);
          if (owned) await run("docker", ["rm", "-f", ...owned.split(/\s+/)]);
          const volumes = await run("docker", [
            "volume",
            "ls",
            "-q",
            "--filter",
            `label=io.fleet.database=${identity.id}`,
          ]);
          if (volumes)
            await run("docker", ["volume", "rm", ...volumes.split(/\s+/)]);
          await run("docker", ["network", "rm", plan.network]).catch(() => {});
        }
      },
    );
  }
