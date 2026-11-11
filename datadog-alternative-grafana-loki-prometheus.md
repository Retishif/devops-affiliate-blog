# Building a Cost-Effective Datadog Alternative with Grafana, Loki, and Prometheus

A self-hosted observability stack can be a practical alternative to SaaS
platforms such as Datadog and Splunk---particularly when log volume is
high, retention requirements are long, and the team is comfortable
operating infrastructure.

The main architectural advantage is control over where telemetry is
processed and stored. Instead of paying a vendor to ingest and retain
every log line, you can use Grafana Loki to index a small set of bounded
labels, store compressed log chunks in S3-compatible object storage, and
query those logs with LogQL. Prometheus handles metrics, while Grafana
provides dashboards and a shared interface.

That does not make observability free. You still pay for compute,
storage, requests, network transfer, backups, and the engineering time
required to operate the platform. The objective is to replace variable
SaaS charges with infrastructure costs you can measure and manage.

This guide explains the cost model, architecture, cardinality risks, a
Docker Compose reference deployment, and how to size and place the
infrastructure.

## 1. The Economics of Log Ingestion: Why Teams Migrate Off SaaS APM

Observability bills often grow faster than teams expect. The main reason
is that telemetry volume and infrastructure complexity tend to increase
together: more services produce more logs, more hosts generate more
metrics, and longer retention keeps more data billable.

### Where SaaS observability costs come from

The exact pricing model differs by vendor and contract, but these cost
drivers are common:

  -----------------------------------------------------------------------
  Cost driver             Why it grows            What to review
  ----------------------- ----------------------- -----------------------
  Host or container       Adding nodes and        Which hosts and
  monitoring              workloads can increase  containers genuinely
                          the monitored-host      need full monitoring?
                          count.                  

  Custom metrics and      Each unique label       Are labels bounded? Are
  cardinality             combination can create  metrics duplicated or
                          another time series and unnecessarily granular?
                          may affect billing or   
                          platform limits.        

  Log ingestion and       High-volume logs can    Which logs are useful,
  indexing                create substantial      and which can be
                          recurring ingestion     filtered or sampled?
                          charges.                

  Log retention           Keeping indexed data    Which logs need
                          for longer periods can  searchable retention,
                          increase the bill.      and for how long?

  Traces and add-on       APM, profiling,         Which features are
  features                synthetics, and other   actually used by the
                          capabilities may be     team?
                          priced separately.      
  -----------------------------------------------------------------------

Before migrating, build a baseline from real invoices and usage reports.
Include ingestion volume, indexed retention, monitored hosts, custom
metrics, traces, and any committed-use discounts. A comparison against a
public list price can be misleading if your organization has negotiated
terms.

### How Loki changes the storage model

Loki is designed around labels rather than full-text indexing every word
in every log line.

At a high level, the pipeline works like this:

1.  **Collect logs.** Grafana Alloy reads logs from applications,
    containers, or supported system sources.
2.  **Attach bounded labels.** The collector adds metadata such as
    `service_name`, `environment`, and `cluster`.
3.  **Write to Loki.** Loki groups records into streams based on their
    label sets.
4.  **Store chunks and index data.** Loki stores compressed log chunks
    and the associated TSDB index objects in object storage.
5.  **Query with LogQL.** Loki uses labels to identify candidate
    streams, then reads and filters the relevant log data.

This is different from a conventional full-text search engine that
builds an inverted index over the contents of every log line. Loki's
approach can reduce indexing overhead and make object storage an
economical place to keep log history.

There is a trade-off: a query that searches a broad time range across
many services may need to read and scan a large amount of data. A cheap
storage tier does not automatically make expensive queries cheap.

### What kind of savings are realistic?

A reduction of 70--85% is sometimes used as a migration target, but it
should not be presented as a guaranteed Loki outcome. Savings depend on
the existing SaaS contract, the volume and type of telemetry, retention,
query patterns, infrastructure prices, and the cost of operating the
replacement.

Use a total-cost comparison:

-   **SaaS:** ingestion, indexed retention, hosts, custom metrics,
    traces, and add-on features.
-   **Self-hosted:** compute, object storage, storage requests,
    persistent volumes, network transfer, backups, and monitoring of the
    observability platform itself.
-   **Operations:** upgrades, security patching, capacity planning,
    incident response, and on-call ownership.

For example, if a team currently spends €4,000 per month and the
replacement costs €1,200 per month---including infrastructure and
incremental operating costs---the modeled reduction is 70%. These
figures are illustrative, not vendor quotes.

The honest business case is not "Loki is 85% cheaper." It is: "We
measured our workload, modeled the full operating cost, and found that
this architecture meets our requirements at a lower total cost."

## 2. System Architecture: Decoupled Storage and Stateless Ingestion

A useful observability architecture separates collection, ingestion,
querying, and durable storage. That separation makes it easier to scale
the busy parts without increasing every component's capacity.

### The LGTM stack

LGTM traditionally stands for Loki, Grafana, Tempo, and Mimir.
Prometheus is often used for metrics collection and alerting, either on
its own or alongside a long-term metrics backend such as Mimir.

For a logs-and-metrics deployment, the core components are:

-   **Grafana:** dashboards, exploration, and alert visualization.
-   **Loki:** log ingestion, storage coordination, and LogQL queries.
-   **Grafana Alloy:** collection and forwarding of logs and other
    telemetry.
-   **Prometheus:** metrics scraping, local TSDB storage, and alert-rule
    evaluation.
-   **S3-compatible object storage:** durable storage for Loki chunks
    and TSDB index objects.

Tempo is a separate tracing backend. Add it when distributed tracing is
part of the requirements; it is not necessary for a logs-and-metrics
deployment.

### The data path

A typical log path looks like this:

1.  Alloy runs close to the workloads and collects application or
    container logs.
2.  Alloy attaches a controlled set of labels and sends batches to Loki.
3.  Loki accepts the data, groups it into streams, and writes chunks and
    index data.
4.  Loki uses object storage for durable chunks and TSDB index objects.
5.  Grafana sends LogQL queries to Loki and PromQL queries to
    Prometheus.

Prometheus has its own storage model. Loki's object-storage
configuration does not automatically move Prometheus TSDB data into the
same bucket. If long-term metrics retention or horizontal metrics
scaling is required, evaluate Mimir or another Prometheus-compatible
remote-write backend separately.

### Loki deployment modes

Choose the deployment mode based on workload size and availability
requirements.

  -----------------------------------------------------------------------
  Mode                    Suitable use            Trade-off
  ----------------------- ----------------------- -----------------------
  Monolithic              Evaluation, smaller     Multiple
                          installations, and      responsibilities share
                          simpler deployments     one process and its
                                                  resource limits.

  Simple Scalable         Existing installations  Check the current Loki
  Deployment (SSD)        that separate read,     lifecycle and migration
                          write, and backend      guidance before
                          targets                 choosing it for a new
                                                  deployment.

  Microservices           Larger systems that     More services,
                          need independent        configuration,
                          scaling of Loki         networking, and
                          components              operational work.
  -----------------------------------------------------------------------

For a new installation, check the current Loki documentation before
choosing SSD. Grafana's deployment guidance and lifecycle
recommendations can change between releases. Do not build a long-lived
platform around a deployment mode without checking its support status.

### What "stateless" really means

Object storage lets Loki keep durable log history outside the compute
nodes. That makes it easier to replace or scale some components without
attaching a disk containing the entire log history.

It does not mean every Loki component is completely stateless. Depending
on the deployment, components still need local working directories,
caches, write-ahead logs, ring membership, or other state. Plan for
those explicitly.

A production design should account for:

-   WAL persistence and recovery.
-   Ring membership and replication.
-   Object-storage latency, throughput, and request limits.
-   Local index and chunk caches.
-   Compaction and retention backlogs.
-   Network transfer between compute and storage.
-   Redundancy across nodes and failure domains.

A bucket is a durable storage dependency, not a complete
high-availability design. Availability also depends on replicated
ingestion, redundant query capacity, component health, and tested
recovery procedures.

## 3. Avoiding the High-Cardinality Label Trap

The most important Loki design rule is straightforward: **do not put
unbounded, request-specific values into stream labels.**

Loki identifies a stream by its label set. Every distinct combination of
label values can create another stream. If labels contain values that
change on every request, the number of streams can grow rapidly and put
pressure on the index, memory, and ingestion path.

### Good labels and bad labels

  -----------------------------------------------------------------------
  Field                   Typical cardinality     Recommendation
  ----------------------- ----------------------- -----------------------
  `service_name`          Bounded by the number   Good stream label
                          of services             

  `environment`           Usually very low        Good stream label

  `cluster`               Bounded if cluster      Usually suitable
                          count is controlled     

  `namespace`             Depends on cluster      Suitable when
                          practices               controlled

  `level`                 Small set such as       Good stream label
                          `debug`, `info`,        
                          `warn`, `error`         

  `request_id`            Potentially unique per  Keep in the log body or
                          request                 structured metadata

  `user_id`               Potentially very large  Do not use as a stream
                                                  label

  `session_id`            Potentially unique per  Do not use as a stream
                          session                 label

  `client_ip`             Potentially large and   Usually keep in the log
                          variable                body

  `trace_id`              Unique per trace        Keep in the log body or
                                                  structured metadata
  -----------------------------------------------------------------------

A poor label design might look like this:

``` yaml
# Conceptual example: do not use request-specific values as stream labels.
labels:
  service_name: checkout
  environment: production
  request_id: req-7f83a91d
  user_id: user-583920
  client_ip: 203.0.113.42
```

A better label set is deliberately small:

``` yaml
labels:
  service_name: checkout
  environment: production
  cluster: prod-eu
  level: error
```

Keep the request-specific information in the log record instead:

``` json
{
  "timestamp": "2026-11-11T10:30:00Z",
  "level": "error",
  "service_name": "checkout",
  "request_id": "req-7f83a91d",
  "user_id": "user-583920",
  "client_ip": "203.0.113.42",
  "message": "payment authorization failed",
  "duration_ms": 842
}
```

This preserves the information engineers need for debugging without
making each request identifier part of the stream index.

### Query request-specific fields with LogQL

For example, to find a particular request:

``` logql
{service_name="checkout", environment="production"}
  |= "payment authorization failed"
  | json
  | request_id="req-7f83a91d"
```

To find errors associated with a particular user:

``` logql
{service_name="checkout", environment="production"}
  | json
  | user_id="user-583920"
  | level="error"
```

These examples assume that the log lines contain valid JSON and the
named fields are present.

There is a performance cost to parsing and filtering fields at query
time. First narrow the search using indexed labels and a sensible time
range. Then apply parsing and filters. A query that scans every service
over several weeks can still be expensive, even if the labels are well
designed.

For repeated investigations, structured metadata or carefully designed
derived fields may improve the workflow. They should not be confused
with stream labels, and they do not make every high-cardinality field
suitable for indexing.

### Make cardinality review part of the development process

For every proposed label:

1.  Estimate the number of possible values.
2.  Consider how it combines with existing labels.
3.  Check whether values can be unique per request, user, session, or
    trace.
4.  Test stream creation and ingestion under representative traffic.
5.  Review Loki's stream and ingestion metrics after deployment.

Do not rely on a simple "number of labels per stream" rule. A stream
with only a few labels can still be problematic if one label has
millions of possible values.

Apply the same discipline to Prometheus. Every unique combination of
metric labels creates a time series, so unbounded dimensions can damage
both systems.

## 4. Production Implementation: Docker Compose & Loki S3 Configuration

The following is a single-host reference deployment using Docker
Compose, Loki, Prometheus, Grafana, and Alloy. It demonstrates the main
configuration and data paths without requiring Kubernetes.

It is not a highly available production cluster. One host, one Loki
process, and one local Prometheus TSDB remain failure domains. Use this
setup to validate the architecture and workload before deciding whether
to move to a distributed deployment.

### 4.1 Directory layout

Create this directory structure:

``` text
observability/
├── .env
├── .gitignore
├── docker-compose.yml
├── loki-config.yaml
├── prometheus.yml
├── alloy-config.alloy
├── grafana/
│   └── provisioning/
│       └── datasources/
│           └── datasources.yml
└── logs/
    └── application.log
```

The `logs/` directory is the input source for this example. In a real
environment, configure Alloy for the actual sources: Kubernetes
workloads, container logs, journald, or application files.

### 4.2 Object-storage credentials

Create a private `.env` file next to `docker-compose.yml`:

``` dotenv
LOKI_S3_BUCKET=observability-prod-loki-logs
LOKI_S3_ENDPOINT=nyc3.digitaloceanspaces.com
LOKI_S3_REGION=nyc3
LOKI_S3_ACCESS_KEY_ID=replace-with-your-real-access-key
LOKI_S3_SECRET_ACCESS_KEY=replace-with-your-real-secret-key
GRAFANA_ADMIN_PASSWORD=replace-with-a-unique-strong-password
```

The endpoint and region above are an example for DigitalOcean Spaces.
Change them to match the bucket and region you actually provision.
Replace both credential values and the Grafana password before starting
the services.

Add `.env` to `.gitignore`:

``` gitignore
.env
```

Restrict access to the file:

``` bash
chmod 600 .env
```

For production, prefer a cloud secret manager or securely injected
secrets rather than a long-lived credentials file. Use a private bucket
and grant the Loki identity only the permissions it needs.

### 4.3 `loki-config.yaml`

This example uses schema v13, TSDB, S3-compatible storage, compaction,
and a 14-day retention period.

``` yaml
auth_enabled: false

server:
  http_listen_address: 0.0.0.0
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: info

common:
  path_prefix: /loki
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: "2024-04-01"
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_index_
        period: 24h

storage_config:
  use_thanos_objstore: true
  object_store:
    s3:
      bucket_name: ${LOKI_S3_BUCKET}
      endpoint: ${LOKI_S3_ENDPOINT}
      region: ${LOKI_S3_REGION}
      access_key_id: ${LOKI_S3_ACCESS_KEY_ID}
      secret_access_key: ${LOKI_S3_SECRET_ACCESS_KEY}
      insecure: false
      bucket_lookup_type: path

  tsdb_shipper:
    active_index_directory: /loki/index
    cache_location: /loki/index_cache
    cache_ttl: 24h

compactor:
  working_directory: /loki/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  delete_request_store: s3

limits_config:
  retention_period: 336h
  max_query_lookback: 336h
  allow_structured_metadata: true

analytics:
  reporting_enabled: false
```

Start Loki with environment-variable expansion enabled:

``` text
-config.expand-env=true
```

Important points:

-   `auth_enabled: false` disables Loki's tenant authentication. Do not
    expose this endpoint directly to untrusted networks. Put
    authentication and authorization in front of it.
-   `replication_factor: 1` is for this single-instance reference
    deployment, not high availability.
-   The TSDB index period is 24 hours.
-   `retention_period: 336h` sets a 14-day retention period.
-   The Compactor performs retention processing asynchronously; deletion
    is not necessarily immediate when a log reaches its expiry time.
-   `delete_request_store: s3` configures the store used for deletion
    requests.
-   `insecure: false` keeps TLS enabled for the remote object-storage
    endpoint.
-   `bucket_lookup_type: path` requests path-style bucket addressing.
    Confirm that the chosen provider and endpoint support it.

Loki's object-storage configuration has changed across releases.
Validate the configuration against the exact Loki version you deploy,
especially when using a non-AWS S3-compatible provider. Consult the
[Loki storage
documentation](https://grafana.com/docs/loki/latest/configure/storage/),
[schema
documentation](https://grafana.com/docs/loki/latest/operations/storage/schema/),
and [retention
guide](https://grafana.com/docs/loki/latest/operations/storage/retention/).

### 4.4 `prometheus.yml`

This configuration scrapes Prometheus itself and Loki's metrics
endpoint:

``` yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets:
          - prometheus:9090

  - job_name: loki
    metrics_path: /metrics
    static_configs:
      - targets:
          - loki:3100
```

Add application and infrastructure scrape jobs based on the exporters
and services in your environment.

### 4.5 `alloy-config.alloy`

This configuration discovers files under `/var/log/app/`, attaches
bounded labels, and forwards log records to Loki:

``` alloy
local.file_match "application_logs" {
  path_targets = [
    {
      "__path__"     = "/var/log/app/*.log",
      "job"          = "application",
      "service_name" = "sample-app",
      "environment"  = "production",
    },
  ]
}

loki.source.file "application_logs" {
  targets    = local.file_match.application_logs.targets
  forward_to = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}
```

The file source is intentionally simple. For Kubernetes, use a
cluster-aware Alloy pipeline and apply the same cardinality controls to
discovered metadata. See the [Alloy component
reference](https://grafana.com/docs/alloy/latest/reference/components/).

### 4.6 Grafana data-source provisioning

Create `grafana/provisioning/datasources/datasources.yml`:

``` yaml
apiVersion: 1

datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false

  - name: Loki
    uid: loki
    type: loki
    access: proxy
    url: http://loki:3100
    editable: false
```

Grafana can now query both services over the internal Compose network.

### 4.7 `docker-compose.yml`

This Compose file defines persistent volumes, internal networking,
resource limits, and service configuration. The image versions are
pinned examples, not a statement that these are the newest patch
releases. Select and validate currently supported versions before
deploying.

``` yaml
services:
  loki:
    image: grafana/loki:3.5.0
    command:
      - -config.file=/etc/loki/loki-config.yaml
      - -config.expand-env=true
    env_file:
      - .env
    volumes:
      - ./loki-config.yaml:/etc/loki/loki-config.yaml:ro
      - loki-data:/loki
    ports:
      - "127.0.0.1:3100:3100"
    networks:
      - observability
    restart: unless-stopped
    mem_limit: 4g
    cpus: 2.0

  prometheus:
    image: prom/prometheus:v3.7.0
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.path=/prometheus
      - --storage.tsdb.retention.time=15d
      - --web.enable-lifecycle
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    ports:
      - "127.0.0.1:9090:9090"
    networks:
      - observability
    restart: unless-stopped
    mem_limit: 2g
    cpus: 1.0

  grafana:
    image: grafana/grafana:12.1.1
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD}
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_ANALYTICS_REPORTING_ENABLED: "false"
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
    ports:
      - "127.0.0.1:3000:3000"
    networks:
      - observability
    restart: unless-stopped
    mem_limit: 1g
    cpus: 1.0
    depends_on:
      - loki
      - prometheus

  alloy:
    image: grafana/alloy:v1.8.3
    command:
      - run
      - --server.http.listen-addr=0.0.0.0:12345
      - /etc/alloy/config.alloy
    volumes:
      - ./alloy-config.alloy:/etc/alloy/config.alloy:ro
      - ./logs:/var/log/app:ro
      - alloy-data:/var/lib/alloy/data
    networks:
      - observability
    restart: unless-stopped
    mem_limit: 512m
    cpus: 0.5
    depends_on:
      - loki

networks:
  observability:
    driver: bridge

volumes:
  loki-data:
  prometheus-data:
  grafana-data:
  alloy-data:
```

The Loki, Prometheus, and Grafana ports are bound to loopback. They are
not directly exposed on the public interface. For remote access, use a
properly secured reverse proxy, VPN, or private network with
authentication and TLS.

The resource limits are starting constraints, not sizing guarantees.
Monitor memory, CPU throttling, disk usage, and query latency, then
adjust them against the real workload.

### 4.8 Validate and start the stack

Create the log directory and a test record:

``` bash
mkdir -p logs

printf '%s\n' \
  '{"level":"info","message":"observability stack initialized"}' \
  > logs/application.log
```

Validate the Compose model:

``` bash
docker compose config --quiet
```

Start the services:

``` bash
docker compose up -d
```

Inspect service status and logs:

``` bash
docker compose ps
docker compose logs --tail=100 loki
docker compose logs --tail=100 alloy
docker compose logs --tail=100 prometheus
```

Check Loki readiness:

``` bash
curl --fail http://127.0.0.1:3100/ready
```

In Grafana Explore, select Loki and run:

``` logql
{service_name="sample-app", environment="production"}
```

A successful readiness response is not proof that the object-storage
path works. Confirm that logs are uploaded, can be queried, and remain
available after a Loki restart. Also test retention expiry and deletion
against the actual bucket.

### Production acceptance checks

Before calling the deployment production-ready, verify:

-   Object-storage writes and reads succeed with the selected provider.
-   Loki can recover after a process or host restart.
-   Required WAL and local state survive the failure scenarios in your
    design.
-   Retention and deletion work as expected.
-   Compaction does not fall behind ingestion.
-   Disk usage and free space are monitored.
-   Queries perform acceptably at representative volume and concurrency.
-   Credentials are private and have least-privilege permissions.
-   Loki and Grafana are not exposed without appropriate access
    controls.
-   Backups and recovery procedures have been tested.

This Compose deployment is a single-host reference architecture. For
high availability, use a distributed Loki design with redundant
components, appropriate replication, durable state, and
failure-domain-aware placement.

## 5. Infrastructure Sizing & Storage Placement Recommendations

Disclosure: provider links in this section are affiliate links. We earn
a commission if you sign up, at no cost to you. Evaluate against your
own requirements and verify current pricing yourself.

The cheapest VM is not necessarily the cheapest observability platform.
The useful comparison is the total cost of compute, object storage,
requests, network transfer, backups, and operational effort.

For this architecture, size three areas separately:

-   **Compute:** log ingestion, querying, compaction, Grafana, and
    metrics collection.
-   **Object storage:** durable Loki chunks and TSDB index objects.
-   **Local storage:** WALs, caches, temporary files, compaction working
    space, and Prometheus TSDB data.

Keep compute and object storage in a suitable nearby region, but verify
the provider's actual network and billing rules rather than assuming
that regional traffic is free.

### 5.1 Starting compute sizes

These are initial planning ranges, not fixed requirements. Actual
resource use depends on log volume, compression, label cardinality,
query patterns, concurrency, and retention.

  -----------------------------------------------------------------------
  Workload                Initial compute         Local storage starting
                          allocation              point
  ----------------------- ----------------------- -----------------------
  Lab or evaluation,      2--4 vCPU, 8 GB RAM     50--100 GB SSD
  below 5 GB/day                                  

  Small production, 5--20 4--8 vCPU, 16--32 GB    100--250 GB SSD
  GB/day                  RAM                     

  Medium production,      8--16 vCPU, 32--64 GB   250--500 GB SSD/NVMe
  20--100 GB/day          RAM as a starting pool; per appropriately sized
                          separate read/write     node
                          capacity when           
                          measurements justify it 

  Larger workloads, above Benchmark a distributed Size each node for its
  100 GB/day              deployment and scale    WAL, caches, temporary
                          components              files, and recovery
                          independently           needs
  -----------------------------------------------------------------------

These ingestion bands refer to raw incoming log volume, not compressed
object-storage usage. Two workloads with the same daily volume can have
very different requirements if one produces many more streams or
requires much more expensive queries.

Measure at least:

-   Sustained and peak ingestion bytes per second.
-   Log lines per second and batch sizes.
-   Active streams and stream creation rate.
-   Query concurrency, p95/p99 latency, and bytes scanned.
-   Compaction throughput and backlog.
-   Local disk latency, IOPS, and free capacity.
-   Object-storage request latency, errors, and throttling.

### 5.2 Size write, read, and backend workloads separately

For a distributed Loki deployment, use the workload profile to guide
capacity.

**Write path: distributors and ingesters**

A small-to-medium starting point might be 4--8 vCPU and 16--32 GB RAM
for an appropriately sized worker group. Prioritize sustained ingestion
throughput, memory headroom, predictable disk latency, and persistent
storage for the WAL.

**Read path: query frontends and queriers**

Start benchmarking with 4--8 vCPU and 16--32 GB RAM for a small query
worker group. Increase capacity when concurrent investigations, wide
time ranges, or expensive parsing expressions cause query latency to
rise. Query workers benefit from CPU, cache memory, and sufficient
network throughput to object storage.

**Backend: compaction and retention**

A small backend component might start around 2--4 vCPU and 8--16 GB RAM.
Size it against compaction duration, retention workload, and storage
request rates. Provide enough scratch space and monitor deletion
backlogs.

These are planning ranges, not vendor sizing guarantees. Benchmark with
representative data before making a capacity commitment.

### 5.3 Estimate object-storage capacity

Use measured compression rather than assuming a universal ratio.

For example, consider 100 GB/day of raw log ingestion and 30 days of
retention:

-   Raw incoming volume: 3 TB.
-   At an assumed 4:1 compression ratio, compressed chunks would use
    approximately 750 GB.
-   Actual billed usage will differ because of index objects, chunk
    overhead, retention timing, and other stored objects.

A simple estimate is:

```text
Estimated chunk storage ≈ (daily raw log volume × retention days) / compression ratio
```

Where:

- `Estimated chunk storage` is the approximate storage used by compressed log chunks.
- `Daily raw log volume` is the incoming, uncompressed log volume per day.
- `Retention days` is the number of days logs are retained.
- `Compression ratio` is the measured ratio of raw log size to compressed chunk size. For example, a 4:1 ratio means 4 GB of raw logs becomes approximately 1 GB of compressed chunks.

Add measured index overhead, temporary retention overlap, and an
appropriate safety margin separately.

Do not choose an object-storage tier based on capacity price alone. Loki
also depends on request latency, read and write throughput, request
limits, and API compatibility.

Benchmark the actual workload. Test sustained uploads, concurrent reads,
request errors, throttling, and recovery behavior. Published throughput
or IOPS limits are useful constraints, but they do not establish
application-level Loki performance.

### 5.4 Cloud provider options

#### DigitalOcean: Droplets, DOKS, and Spaces

[**DigitalOcean**](https://www.digitalocean.com/) is worth evaluating
when the team wants relatively straightforward cloud infrastructure.

-   **Droplets:** Run a Docker Compose deployment or dedicated Loki
    components.
-   **DOKS:** Run Kubernetes workloads when independent deployments,
    scheduling, and scaling justify the additional operational
    complexity.
-   **Spaces:** Store Loki chunks and index objects through an
    S3-compatible API.

Spaces offers S3 API compatibility, but compatibility is not identical
to AWS S3 in every detail. Test the operations required by your Loki
release and confirm the endpoint, region, addressing mode, and
credentials.

Useful references:

-   [Spaces S3
    compatibility](https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/)
-   [Droplet pricing and
    details](https://docs.digitalocean.com/products/droplets/details/pricing/)
-   [DigitalOcean bandwidth
    billing](https://docs.digitalocean.com/platform/billing/bandwidth/)

#### Vultr: High Frequency Compute, VKE, and Object Storage

[**Vultr**](https://www.vultr.com/?ref=9935169) is another option to benchmark,
particularly when its regional compute and storage offerings fit the
deployment.

-   **High Frequency Compute:** Evaluate for CPU-sensitive log
    processing and query workloads.
-   **VKE:** Use managed Kubernetes when workload separation and
    orchestration justify it.
-   **Object Storage:** Store durable Loki chunks and index objects,
    subject to compatibility and performance testing.

Review the storage endpoint, S3 compatibility, tier limits, throughput,
IOPS, and network charges before selecting a tier.

Useful references:

-   [Vultr Object Storage
    documentation](https://docs.vultr.com/products/storage/object-storage/)
-   [Vultr S3 compatibility
    matrix](https://docs.vultr.com/products/storage/object-storage/s3-compatibility-matrix)

#### AWS: EC2, EKS, and S3

[**AWS**](https://aws.amazon.com/) is a sensible baseline for
organizations already using AWS networking, IAM, security controls, and
operational tooling.

-   **EC2:** Run a VM-based deployment or individual Loki components.
-   **EKS:** Run a distributed observability platform on Kubernetes.
-   **S3:** Store chunks and index objects using native AWS integration
    and IAM.

AWS integration can reduce the work involved in fitting the platform
into an existing security and governance model. It does not eliminate
the need to model compute, S3 requests, storage, persistent volumes, and
network transfer.

### 5.5 Model network transfer explicitly

Do not compare compute and storage prices while ignoring the traffic
between them.

Loki writes chunks to object storage, queries retrieve chunks, and
compaction and retention generate additional object operations. Broad
queries and repeated scans can generate significant reads.

Before selecting a provider:

1.  Choose the intended compute and object-storage regions.
2.  Confirm that the storage service supports the S3 operations required
    by your Loki version.
3.  Measure ingestion traffic and query-driven reads.
4.  Check which traffic is included, billed, or subject to limits.
5.  Estimate object requests, retention operations, and data transfer at
    the expected workload.
6.  Benchmark the full stack rather than comparing storage price per GB
    alone.

Keeping compute and storage geographically close generally helps latency
and transfer efficiency. It does not guarantee that traffic will be free
or classified as private-network traffic.

### 5.6 Choose a deployment pattern that matches the team

**Pattern A: Single-host deployment**

Run Docker Compose on one appropriately sized VM, use persistent local
volumes, and store Loki's durable data in S3-compatible object storage.
Restrict access to the observability interfaces and back up
configuration off-host.

This is suitable for smaller workloads, initial migrations, and
environments where downtime during a host failure is acceptable.

**Pattern B: Kubernetes with separated services**

Run Loki, Grafana, and the metrics backend in Kubernetes. Use persistent
storage for required local state and object storage for durable Loki
data.

This is suitable for teams already operating Kubernetes and needing
independent scaling or controlled rollouts.

**Pattern C: Distributed, highly available observability**

Separate Loki's write, read, and backend responsibilities across
redundant workloads. Design ring membership, replication, failure
domains, storage access, and recovery procedures explicitly.

This is suitable for critical platforms where observability must remain
available during individual node or workload failures.

For many teams, the sensible sequence is to start with a measured
single-host deployment, establish real ingestion and query behavior, and
then move to Kubernetes or a distributed design when the requirements
justify it. Kubernetes is not automatically cheaper or simpler just
because the applications being monitored already run on Kubernetes.

### 5.7 Production readiness checklist

Before treating the migration as complete, verify that:

-   [ ] Stream labels have bounded cardinality.
-   [ ] Ingestion, query, and compaction resource use has been measured.
-   [ ] Loki retention is enabled and expiry has been tested.
-   [ ] Object storage is private and credentials are securely managed.
-   [ ] Required S3 operations work with the selected provider.
-   [ ] Loki's local WAL and required state survive the intended failure
    scenarios.
-   [ ] Prometheus retention and backup requirements are defined
    separately.
-   [ ] Observability components have health checks and capacity alerts.
-   [ ] Network access, authentication, and authorization match the
    threat model.
-   [ ] The cost model includes compute, storage, requests, transfer,
    backups, and operations.
-   [ ] Image versions are pinned, tested, and covered by an upgrade and
    rollback plan.

## Conclusion

A Grafana, Loki, and Prometheus stack can be a strong alternative to
SaaS observability for teams that need control over log retention,
storage placement, and infrastructure costs.

The savings do not come from one configuration switch. They come from
making several engineering decisions well: keep labels bounded, store
durable log data in suitable object storage, control query scope, size
compute from measurements, and account for network and operational
costs.

DigitalOcean, Vultr, and AWS are all viable candidates, but the right
choice depends on the actual workload, S3 compatibility, regional
transfer economics, and the team's existing cloud expertise.

Start with a representative workload and a complete cost model. If the
self-hosted stack meets the required query performance, retention,
security, and availability targets at a lower total cost, the migration
has a defensible engineering case.
