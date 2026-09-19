import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ROOT = process.env.THE_AGENT_COMPANY_ROOT || 'benchmarks/the-agent-company';
export const THE_AGENT_COMPANY_TASKS = [
  'pm-ask-for-issue-and-create-in-gitlab-image', 'pm-assign-issues-image', 'pm-update-gitlab-issue-from-plane-status-image', 'pm-update-plane-issue-from-gitlab-status-image',
  'ds-answer-spreadsheet-questions-image', 'ds-calculate-spreadsheet-stats-image', 'ds-merge-multiple-sheets-image', 'ds-organise-report-sus-data-image',
  'sde-check-and-run-unit-test-image', 'sde-find-answer-in-codebase-1-image', 'sde-fix-factual-mistake-image', 'sde-write-a-unit-test-for-append_file-function-image',
  'hr-collect-feedbacks-image', 'hr-create-career-ladder-image', 'hr-organize-talent-info-image', 'hr-resume-screening-image',
  'finance-budget-variance-image', 'finance-expense-validation-image', 'finance-invoice-matching-image', 'finance-revenue-reconciliation-image',
  'qa-escalate-emergency-image', 'qa-update-issue-status-according-to-colleagues-image', 'admin-make-spreadsheet-image', 'admin-read-survey-and-summarise-image',
];

export function theAgentCompanyAdapter({ root = DEFAULT_ROOT } = {}) {
  return {
    name: 'theagentcompany',
    taskIds: THE_AGENT_COMPANY_TASKS,
    async doctor() { try { await fs.access(path.join(root, 'workspaces')); return { available: true, root, taskCount: THE_AGENT_COMPANY_TASKS.length }; } catch { return { available: false, root, taskCount: THE_AGENT_COMPANY_TASKS.length, reason: 'repository_not_downloaded' }; } },
    async manifest() { return { benchmark: 'TheAgentCompany', source: 'public_task_images_v1', taskCount: THE_AGENT_COMPANY_TASKS.length, taskIds: THE_AGENT_COMPANY_TASKS, root, evaluator: 'task-container-eval.py', approvalRequired: false }; },
  };
}
