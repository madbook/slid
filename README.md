# slid

A partial rebuild of https://github.com/madbook/seline to run in deno.

Can be installed by running

```
deno install --allow-write=/dev/tty --allow-read=/dev/tty --allow-run --allow-env --unstable https://raw.githubusercontent.com/madbook/slid/master/slid.ts
```

* `--allow-write=/dev/tty --allow-read=/dev/tty` to allow reading/writing from the `/dev/tty`
* `--allow-run` to allow running `stty size` to get the tty size, as deno doesn't expose this natively.  Unfortunately deno doesn't currently allow scoping this flag to `stty` specifically.
* `--allow-env` to allow reading the `TERM_PROGRAM` env variable, which changes one of the control characters used to reposition the cursor
* `--unstable` exposes Dev.setRaw, which allows reading individual keystrokes from tty
