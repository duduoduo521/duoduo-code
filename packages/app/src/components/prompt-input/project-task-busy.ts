// Matches the fail-fast 409 error produced by the backend when a project
// already has a running task. See `duo-smart-layer` `/task/acquire` (which sends
// `timeout: 0`) and `ProjectTaskCoordinator::acquire` bailing with
// "Project task slot unavailable for {project_path} (fail-fast)".
export function isProjectTaskBusyError(message: string): boolean {
  return /project task slot unavailable/i.test(message)
}
