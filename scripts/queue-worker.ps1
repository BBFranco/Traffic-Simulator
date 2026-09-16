# Keeps a `queue:work` process alive for this app so uploaded traffic-count
# videos get processed without a developer having to remember to start one
# manually. Registered as scheduled task "TrafficSimQueueWorker" (ONLOGON),
# see queue-worker-task.md for setup/removal.
Set-Location "C:\Users\FrancoVorster\Herd\Traffic-Simulator"

while ($true) {
    & "C:\Users\FrancoVorster\.config\herd\bin\php.bat" artisan queue:work --queue=default --timeout=3600 --tries=1 *>> "storage\logs\queue-worker.log"
    Start-Sleep -Seconds 5
}
