const REQUIRED_ROLES = ['planner', 'worker', 'reviewer'];

function normalizeRoles(roles) {
  if (Array.isArray(roles)) {
    return roles.map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object' && typeof entry.role === 'string') {
        return entry.role.trim();
      }
      return '';
    });
  }

  if (roles && typeof roles === 'object') {
    return Object.entries(roles).map(([role, value]) => {
      if (typeof value === 'string' && value.trim() === '') return '';
      return role.trim();
    });
  }

  return [];
}

function validateRequiredRoles(roles) {
  const normalizedRoles = normalizeRoles(roles);

  if (normalizedRoles.some((role) => role === '')) {
    throw new Error('Missing required peer role: roles must include non-blank planner, worker, and reviewer entries.');
  }

  const roleSet = new Set(normalizedRoles);
  const missingRoles = REQUIRED_ROLES.filter((role) => !roleSet.has(role));
  if (missingRoles.length > 0) {
    throw new Error(`Missing required peer role: ${missingRoles.join(', ')}.`);
  }

  const unexpectedRoles = normalizedRoles.filter((role) => !REQUIRED_ROLES.includes(role));
  if (unexpectedRoles.length > 0) {
    throw new Error(`Unexpected peer role: ${unexpectedRoles.join(', ')}. Required roles are planner, worker, and reviewer.`);
  }
}

export function buildRoleCollaborationTranscript({ goal, roles } = {}) {
  const normalizedGoal = typeof goal === 'string' ? goal.trim() : '';
  if (normalizedGoal === '') {
    throw new Error('A non-blank collaboration goal is required.');
  }

  validateRequiredRoles(roles);

  return [
    {
      role: 'planner',
      summary: `Planner defines the goal: ${normalizedGoal}`,
      goal: normalizedGoal,
      action: 'scope',
    },
    {
      role: 'worker',
      summary: `Worker implements the goal: ${normalizedGoal}`,
      goal: normalizedGoal,
      action: 'implement',
    },
    {
      role: 'reviewer',
      summary: `Reviewer verifies the goal: ${normalizedGoal}`,
      goal: normalizedGoal,
      action: 'review',
    },
  ];
}
