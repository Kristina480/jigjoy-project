import type {AgentRole} from './role-catalog.js';

type TeamRecipe = {
	name: string;
	when: string;
	steps: Array<{
		key: string;
		role: AgentRole;
		dependsOn: string[];
		purpose: string;
	}>;
};

// Examples for the coordinator, not keyword rules or automatically created agents.
export const teamRecipes: TeamRecipe[] = [
	{
		name: 'ui_design_implementation',
		when: 'Create or change a working screen, website appearance, layout, or UI design. For a design specification only, stop after designer.',
		steps: [
			{
				key: 'design',
				role: 'designer',
				dependsOn: [],
				purpose:
					'Inspect the current interface and specify layout, visual decisions and interaction states.',
			},
			{
				key: 'ui_context',
				role: 'frontend',
				dependsOn: [],
				purpose:
					'Inspect existing components, file boundaries and integration points in parallel with the designer. Read-only; do not implement the proposed design yet.',
			},
			{
				key: 'implement',
				role: 'frontend',
				dependsOn: ['design', 'ui_context'],
				purpose: 'Implement the designer result in the existing UI.',
			},
			{
				key: 'verify',
				role: 'tester',
				dependsOn: ['implement'],
				purpose:
					'Check the implemented UI against the design and existing behavior.',
			},
		],
	},
	{
		name: 'fullstack_feature',
		when: 'A feature needs independently developed frontend and backend parts. For a small cohesive change use fullstack and tester instead.',
		steps: [
			{
				key: 'contract',
				role: 'api_designer',
				dependsOn: [],
				purpose: 'Specify a shared API contract.',
			},
			{
				key: 'ui',
				role: 'frontend',
				dependsOn: ['contract'],
				purpose: 'Implement UI against the contract in a separate file scope.',
			},
			{
				key: 'server',
				role: 'backend',
				dependsOn: ['contract'],
				purpose:
					'Implement server behavior against the contract in a separate file scope.',
			},
			{
				key: 'connect',
				role: 'integration',
				dependsOn: ['ui', 'server'],
				purpose: 'Connect both parts and resolve integration issues.',
			},
			{
				key: 'verify',
				role: 'tester',
				dependsOn: ['connect'],
				purpose: 'Verify the integrated feature.',
			},
		],
	},
	{
		name: 'backend_feature',
		when: 'A server-only change with no UI work.',
		steps: [
			{
				key: 'server',
				role: 'backend',
				dependsOn: [],
				purpose: 'Implement the scoped server behavior.',
			},
			{
				key: 'verify',
				role: 'tester',
				dependsOn: ['server'],
				purpose: 'Verify positive and negative cases.',
			},
		],
	},
	{
		name: 'bug_fix',
		when: 'A reproducible defect requires root cause analysis and a scoped fix.',
		steps: [
			{
				key: 'fix',
				role: 'debugger',
				dependsOn: [],
				purpose: 'Reproduce the defect and fix its root cause.',
			},
			{
				key: 'verify',
				role: 'tester',
				dependsOn: ['fix'],
				purpose: 'Verify the original failure and relevant regressions.',
			},
		],
	},
	{
		name: 'landing_page',
		when: 'Build a landing page with new messaging and visual design. Add SEO only if search visibility is in scope.',
		steps: [
			{
				key: 'copy',
				role: 'copywriter',
				dependsOn: [],
				purpose: 'Draft accurate page copy for the supplied audience.',
			},
			{
				key: 'design',
				role: 'designer',
				dependsOn: [],
				purpose:
					'Specify layout and content slots from the brief while copy is drafted independently. Frontend will combine the final copy and layout.',
			},
			{
				key: 'page',
				role: 'frontend',
				dependsOn: ['design', 'copy'],
				purpose: 'Implement the page using the actual copy and design.',
			},
			{
				key: 'verify',
				role: 'tester',
				dependsOn: ['page'],
				purpose: 'Verify layout, links and responsive behavior.',
			},
		],
	},
	{
		name: 'marketing_campaign',
		when: 'Plan a marketing campaign and create social media drafts, without changing application code.',
		steps: [
			{
				key: 'plan',
				role: 'marketing',
				dependsOn: [],
				purpose: 'Define audience, message, goals and campaign scope.',
			},
			{
				key: 'posts',
				role: 'social_media',
				dependsOn: ['plan'],
				purpose: 'Write platform-specific drafts based on the campaign plan.',
			},
		],
	},
	{
		name: 'database_change',
		when: 'A data schema change requires application changes.',
		steps: [
			{
				key: 'schema',
				role: 'database_architect',
				dependsOn: [],
				purpose: 'Design schema and migration requirements.',
			},
			{
				key: 'server',
				role: 'backend',
				dependsOn: ['schema'],
				purpose: 'Implement the schema and corresponding application changes.',
			},
			{
				key: 'verify',
				role: 'tester',
				dependsOn: ['server'],
				purpose: 'Check constraints and application behavior.',
			},
		],
	},
	{
		name: 'authentication_feature',
		when: 'Implement login, session or authorization behavior with a UI.',
		steps: [
			{
				key: 'auth',
				role: 'authentication',
				dependsOn: [],
				purpose: 'Implement the authentication contract and permission rules.',
			},
			{
				key: 'ui',
				role: 'frontend',
				dependsOn: ['auth'],
				purpose: 'Implement UI against the authentication contract.',
			},
			{
				key: 'review',
				role: 'security',
				dependsOn: ['auth', 'ui'],
				purpose: 'Review session and access boundaries.',
			},
			{
				key: 'verify',
				role: 'tester',
				dependsOn: ['review'],
				purpose: 'Test expected access and denied access cases.',
			},
		],
	},
	{
		name: 'performance_improvement',
		when: 'Investigate and improve a measured application bottleneck.',
		steps: [
			{
				key: 'optimize',
				role: 'performance',
				dependsOn: [],
				purpose: 'Profile, optimize within scope and compare measurements.',
			},
			{
				key: 'verify',
				role: 'tester',
				dependsOn: ['optimize'],
				purpose: 'Check behavior is preserved.',
			},
		],
	},
	{
		name: 'ai_feature',
		when: 'Implement an AI feature with a UI. Use prompt_engineer only when separate prompt work is needed.',
		steps: [
			{
				key: 'ai',
				role: 'ai_engineer',
				dependsOn: [],
				purpose: 'Implement AI behavior and specify the interface contract.',
			},
			{
				key: 'ui',
				role: 'frontend',
				dependsOn: ['ai'],
				purpose: 'Implement the user flow using the AI contract.',
			},
			{
				key: 'verify',
				role: 'tester',
				dependsOn: ['ai', 'ui'],
				purpose: 'Test success, failure and evaluation cases.',
			},
		],
	},
	{
		name: 'ci_pipeline',
		when: 'Configure automated build and test checks, without deployment.',
		steps: [
			{
				key: 'pipeline',
				role: 'ci_cd',
				dependsOn: [],
				purpose: 'Implement the CI configuration.',
			},
			{
				key: 'review',
				role: 'quality',
				dependsOn: ['pipeline'],
				purpose: 'Review workflow triggers and validate relevant commands.',
			},
		],
	},
	{
		name: 'data_report',
		when: 'Analyze a provided dataset and produce findings without application code changes.',
		steps: [
			{
				key: 'analysis',
				role: 'data_analyst',
				dependsOn: [],
				purpose:
					'Analyze supplied data and explain reproducible findings and limitations.',
			},
		],
	},
];
