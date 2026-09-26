# Remove an agent from a machine

Run `fleet uninstall` **on the node being removed**. It works from Windows Command Prompt or PowerShell, macOS Terminal, and Linux shells. Windows requires an elevated terminal to delete the `FleetAgent` service; Linux needs permission to stop systemd and remove `/var/lib/fleet-os`.

```text
fleet uninstall
fleet uninstall --force
fleet uninstall --force --purge-data --stop-docker
```

The command shows the node and local state before confirmation. `--force` skips the prompt; it does not expand deletion scope. It disables and stops the agent before doing anything else, revokes the node through the control plane, removes Docker containers and networks carrying Fleet's `fleet-os.managed=true` label, and deletes the agent's installed state, service, and standard binary. `fleet unpair` remains an alias.

Application volumes are preserved unless `--purge-data` is set. That flag deletes named volumes mounted by Fleet containers only when no non-Fleet container also mounts them. Back up application data before using it. `--stop-docker` attempts to shut down Docker after cleanup, but leaves it running when other containers are active. Docker Desktop itself is not uninstalled. The CLI also remains installed; remove it separately with `npm uninstall -g @yadurajfleetos/cli`.

If the control plane is offline or the CLI has no owner login, local removal continues and exits with an error explaining how to revoke the node from another signed-in machine using `fleet nodes rm <name> --force`. If Docker is unavailable, Docker cleanup is reported as incomplete. Run the command again when Docker is available. Custom installation paths outside the standard installer directories may need manual cleanup.
