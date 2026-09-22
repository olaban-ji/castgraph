import { defineRailway, preserve, project, service } from "railway/iac";

// This repository manages only its own resources in the environment. The
// Neo4j and Redis services are provisioned from the Railway dashboard and
// are deliberately not claimed here.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "cinedikt";

export default defineRailway(() => {
  const cinedikt = service("cinedikt", {
    build: {
      // Without this the service falls back to Railway's default builder,
      // which would ignore the multi-stage Dockerfile that builds the map,
      // trims the binary and sets APP_ENV=production.
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    deploy: {
      // /api/healthz pings Neo4j and Redis, so a machine that cannot
      // serve never joins the load balancer. The timeout covers a cold
      // start where both are waking.
      healthcheckPath: "/api/healthz",
      healthcheckTimeout: 120,
      // restartPolicyType (ON_FAILURE) and sleepApplication (false) are
      // Railway's defaults and are deliberately not declared: the API
      // stores a default as null, so declaring one leaves `config plan`
      // permanently dirty. Both matter to this service — the warmer
      // crawls between requests and a sleeping machine would drop that
      // work — but the default is already what we want.
    },
    // Every variable the service holds is named here so this file is the
    // whole picture, and every one is preserve()d: the values stay in
    // Railway, out of the repository, and are not touched by an apply.
    // A name missing from this list would be deleted on the next apply.
    env: {
      TMDB_API_KEY: preserve(),
      TMDB_ACCESS_TOKEN: preserve(),
      TMDB_RATE_PER_SEC: preserve(),
      NEO4J_URI: preserve(),
      NEO4J_USER: preserve(),
      NEO4J_PASSWORD: preserve(),
      REDIS_URL: preserve(),
      REDIS_PASSWORD: preserve(),
      REDISHOST: preserve(),
      REDISPORT: preserve(),
      REDISUSER: preserve(),
      REDISPASSWORD: preserve(),
      OMDB_API_KEY: preserve(),
      POSTHOG_PROJECT_TOKEN: preserve(),
      POSTHOG_HOST: preserve(),
      WEB_DIR: preserve(),
    },
  });

  return project("cinedikt", {
    resources: [cinedikt],
  });
});
