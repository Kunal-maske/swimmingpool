function escapeHtml(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
}

function escapeCsvCell(value) {
  let text = String(value ?? "");
  if (/^[\u0000-\u0020]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function calculateAge(dateOfBirth, today = new Date()) {
  if (typeof dateOfBirth !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    return null;
  }

  const [birthYear, birthMonth, birthDay] = dateOfBirth.split("-").map(Number);
  const birthDate = new Date(Date.UTC(birthYear, birthMonth - 1, birthDay));
  if (
    birthDate.getUTCFullYear() !== birthYear ||
    birthDate.getUTCMonth() !== birthMonth - 1 ||
    birthDate.getUTCDate() !== birthDay
  ) {
    return null;
  }

  const todayYear = today.getUTCFullYear();
  const todayMonth = today.getUTCMonth() + 1;
  const todayDay = today.getUTCDate();
  if (
    Number.isNaN(today.getTime()) ||
    birthYear > todayYear ||
    (birthYear === todayYear &&
      (birthMonth > todayMonth || (birthMonth === todayMonth && birthDay > todayDay)))
  ) {
    return null;
  }

  return todayYear - birthYear -
    (todayMonth < birthMonth || (todayMonth === birthMonth && todayDay < birthDay) ? 1 : 0);
}

function isEligibleForPlan(dateOfBirth, plan, today = new Date()) {
  const age = calculateAge(dateOfBirth, today);
  return age !== null &&
    age <= 120 &&
    age >= plan.age_min &&
    (plan.age_max === null || age <= plan.age_max);
}

function isPlanForAccount(plan, accountType) {
  return Boolean(plan && plan.audience === accountType);
}

function participantTypeLabel(memberType) {
  return {
    employee: "Employee",
    outside: "Outside member",
    family: "Family member",
    guest: "Guest",
  }[memberType] || "Member";
}

function accountTypeLabel(accountType) {
  return {
    faculty: "Faculty",
    outside: "Outside member",
  }[accountType] || "Unknown";
}

function isAddableMemberType(memberType) {
  return memberType === "family" || memberType === "guest";
}

if (typeof module !== "undefined") {
  module.exports = {
    calculateAge,
    accountTypeLabel,
    escapeCsvCell,
    escapeHtml,
    isAddableMemberType,
    isEligibleForPlan,
    isPlanForAccount,
    participantTypeLabel,
  };
}
