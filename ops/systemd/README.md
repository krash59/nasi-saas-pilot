# Retention purge schedule

Not installed by default. Install (user timer on this machine):

    cp ops/systemd/nasi-retention-purge.* ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now nasi-retention-purge.timer

Hosted environments run the same command (`npm run purge:retention`) from the platform's
scheduler daily. The job connects as a member of `nasi_retention_purge` (NOBYPASSRLS).
