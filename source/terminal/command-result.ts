export interface CommandResult {
	success: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut?: boolean;
}
