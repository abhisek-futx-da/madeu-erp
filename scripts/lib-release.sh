#!/usr/bin/env bash
# Shared, side-effect-free helpers for migration and release scripts.

file_md5() {
  local path="${1:?file_md5 requires a path}"
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "${path}" | awk '{print $1}'
  elif command -v md5 >/dev/null 2>&1; then
    md5 -q "${path}"
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -md5 -r "${path}" | awk '{print $1}'
  else
    echo "need md5sum, md5, or openssl to checksum migrations" >&2
    return 1
  fi
}

postgres_server_major() {
  local db="${1:-postgres}"
  psql -v ON_ERROR_STOP=1 -d "${db}" -tAc \
    "select current_setting('server_version_num')::int / 10000" | tr -d '[:space:]'
}

postgres_tool_major() {
  local tool="${1:?postgres_tool_major requires a tool name}"
  "${tool}" --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/'
}

# Selects local pg_dump/pg_restore when they can read the target server. If the
# client is older than the server, use the matching official client image when
# Docker is available. This keeps a Mac with Homebrew PostgreSQL 14 from
# producing a false-negative against a PostgreSQL 16 deployment.
select_pg_archive_mode() {
  local db="${1:-postgres}" server_major local_major
  PG_ARCHIVE_IMAGE_SELECTED="${PG_ARCHIVE_IMAGE:-}"
  if [ -n "${PG_ARCHIVE_IMAGE_SELECTED}" ]; then
    export PG_ARCHIVE_IMAGE_SELECTED
    return 0
  fi

  server_major="$(postgres_server_major "${db}")"
  if command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1; then
    local_major="$(postgres_tool_major pg_dump)"
    if [ "${local_major}" -ge "${server_major}" ]; then
      export PG_ARCHIVE_IMAGE_SELECTED=''
      return 0
    fi
  fi

  if command -v docker >/dev/null 2>&1 && [[ "${PGHOST:-}" != /* ]]; then
    PG_ARCHIVE_IMAGE_SELECTED="postgres:${server_major}-alpine"
    export PG_ARCHIVE_IMAGE_SELECTED
    return 0
  fi

  echo "PostgreSQL ${server_major} needs pg_dump/pg_restore ${server_major} or newer; set PG_ARCHIVE_IMAGE=postgres:${server_major}-alpine" >&2
  return 1
}

# Runs a PostgreSQL archive tool in the selected official client image. Input
# and output stay on the host through stdin/stdout; no database files or
# credentials are baked into the image.
docker_pg_archive() {
  local tool="${1:?docker_pg_archive requires a tool}"; shift
  local docker_host="${PGHOST:-127.0.0.1}"
  local use_host_network=false
  local -a env_args

  if [[ "${docker_host}" = "127.0.0.1" || "${docker_host}" = "localhost" ]]; then
    if [ "$(uname -s)" = "Darwin" ]; then
      docker_host="host.docker.internal"
    else
      use_host_network=true
    fi
  fi

  env_args=(
    -e "PGHOST=${docker_host}"
    -e "PGPORT=${PGPORT:-5432}"
    -e "PGUSER=${PGUSER:-postgres}"
  )
  [ -z "${PGPASSWORD:-}" ] || env_args+=(-e PGPASSWORD)
  [ -z "${PGSSLMODE:-}" ] || env_args+=(-e PGSSLMODE)

  if [ "${use_host_network}" = true ]; then
    docker run --rm -i --network host "${env_args[@]}" \
      "${PG_ARCHIVE_IMAGE_SELECTED}" "${tool}" "$@"
  else
    docker run --rm -i "${env_args[@]}" \
      "${PG_ARCHIVE_IMAGE_SELECTED}" "${tool}" "$@"
  fi
}
