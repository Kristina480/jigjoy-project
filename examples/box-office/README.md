# Box Office: prepared factory exercise

This folder contains the user's specification as input for a future JigJoy run. It contains no generated API implementation and is not evidence of a completed model-backed generation.

## First inspect the plan

After applying the factory upgrade and restarting JigJoy, send this in its chat:

```text
Read examples/box-office/specification.md in full using load_project_requirements.
For now, only propose the smallest capable team and its dependency graph.
Explain which agents can work concurrently. Do not implement anything yet.
```

## Later, generate through JigJoy

When you are ready, start a clean session and send:

```text
Load examples/box-office/specification.md in full using load_project_requirements.
Implement that specification through the agent team in hidden/box-office/.
Inspect the actual workspace and OS first. Use native file tools to write code.
Choose the required roles and submit one complete task graph with separate file scopes.
Run independent tasks concurrently. Keep all inventory/hold/discount/waitlist transactions
in one coherent domain scope. Include independent HTTP tests, security and quality review.
Verify a standalone install/build on Node 22 and start the generated API using start_process
with a test PORT that differs from JigJoy's port. Check HOLD_SECONDS behavior and stop it
when verification finishes. Fix blockers and report actual checks. Do not commit, push,
create a pull request or deploy.
```

If `hidden/box-office/` already contains the manually prepared reference API from an earlier download, move that folder outside the workspace before the real generation run. The agents should generate from the specification rather than copy a ready answer.

## Validation status

The factory upgrade is tested with deterministic inference fixtures and actual native file/process/localhost HTTP tools. No real-model Box Office generation has been run by this upgrade workflow. Record that later run's actual agents, tool output, generated files and checks before claiming success.
