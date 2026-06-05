- The two `RUN npx -y playwright@1.61.0-alpha-1778188671000` in `Dockerfile` are dubious
- The `ANTHROPIC_API_KEY` transfer is useless.  
   How to not have to log into Claude Code via the Browser?
- How to avoid the questions at the first launch of Claude Code?


Quick smoke test:
```
Log in http://host.docker.internal:8090/squash/login as admin / admin and generate a screenshot.
```

In the CLAUDE.md indicate:
- Do not try to access the API, only use the UI.

Docker Compose file to use for starting SquaqhTM (with `docker compose up -d`)
```yaml
  services:
    squashtm-pg:
      container_name: squashtm-pg
      environment:
        POSTGRES_DB: squashtm
        POSTGRES_USER: squashtm
        POSTGRES_PASSWORD: MustB3Ch4ng3d
      image: postgres:17
      ports:
        - 5432:5432
      networks:
        - squashtm-net

    squashtm:
      container_name: squashtm
      image: squashtest/squash:nightly
      entrypoint: ["/bin/sh", "-c", "[ -f /tmp/certs/import-certs.sh ] && /tmp/certs/import-certs.sh ; /sbin/tini -- /bin/sh -c /opt/install-script.sh"]
      depends_on:
        - squashtm-pg
      environment:
        SPRING_PROFILES_ACTIVE: postgresql
        SPRING_DATASOURCE_URL: jdbc:postgresql://squashtm-pg:5432/squashtm
        SPRING_DATASOURCE_USERNAME: squashtm
        SPRING_DATASOURCE_PASSWORD: MustB3Ch4ng3d
      ports:
        - 8090:8080
      volumes:
        - squashtm-logs:/opt/squash-tm/logs
        - ./certs:/tmp/certs:ro
      networks:
        - squashtm-net

  volumes:
    squashtm-logs:

  networks:
    squashtm-net:
      name: squashtm-net
```
