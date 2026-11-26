# CI report fixtures (spec 15)

- `junit.xsd`: the Jenkins JUnit schema, `junit-10.xsd` from jenkinsci/xunit-plugin at commit `0afa700702a6617f483cfd9407711976dc0bd74a` (MIT, license header kept). `xmllint --schema` validates catscan's `--junit` output against it.
- `codequality.schema.json`: GitLab's documented Code Quality report fields as a JSON schema (GitLab publishes none); its `$comment` names the doc page and the review date.
