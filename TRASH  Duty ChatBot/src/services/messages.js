'use strict';

/**
 * LINE message builders. We use the "buttons" Template Message for the
 * assignment prompt so users can tap Done / Not Free / Not at Home inline.
 * Template button text has a 160-char limit; we keep prompts short.
 */

function assignmentTemplate({ name, taskId, weekKey }) {
  const text = `🗑 This week's trash duty: ${name}\n(Week of ${weekKey})`;
  return {
    type: 'template',
    altText: `This week's trash duty: ${name}`,
    template: {
      type: 'buttons',
      text: text.length > 160 ? text.slice(0, 157) + '…' : text,
      actions: [
        { type: 'postback', label: '✅ Done', data: `action=done&taskId=${taskId}`, displayText: 'Done' },
        { type: 'postback', label: '🙅 Not Free', data: `action=not_free&taskId=${taskId}`, displayText: 'Not Free' },
        { type: 'postback', label: '🏠 Not at Home', data: `action=not_home&taskId=${taskId}`, displayText: 'Not at Home' },
      ],
    },
  };
}

function completedTemplate({ name, taskId }) {
  return {
    type: 'template',
    altText: `${name} completed trash duty. Thank you!`,
    template: {
      type: 'buttons',
      text: `✅ ${name} completed trash duty. Thank you!`.slice(0, 160),
      actions: [
        { type: 'postback', label: '↩ Undo (within 24h)', data: `action=undo&taskId=${taskId}`, displayText: 'Undo' },
      ],
    },
  };
}

function reminderText({ name }) {
  return {
    type: 'text',
    text: `⏰ Reminder: ${name} has not confirmed trash duty yet.\nTap Done when finished, or Not Free / Not at Home if you can't do it this week.`,
  };
}

function skipText({ skipperName, newAssigneeName, reason }) {
  const reasonLabel = reason === 'not_home' ? 'not at home' : 'not free';
  return {
    type: 'text',
    text: `${skipperName} is ${reasonLabel}.\nNext duty: ${newAssigneeName}`,
  };
}

function backHomeText({ name }) {
  return {
    type: 'text',
    text: `👋 Welcome back, ${name}. You've rejoined the rotation.`,
  };
}

function forceAssignText({ name }) {
  return {
    type: 'text',
    text: `📌 Admin assigned this week's trash duty to ${name}.`,
  };
}

function plain(text) {
  return { type: 'text', text };
}

module.exports = {
  assignmentTemplate,
  completedTemplate,
  reminderText,
  skipText,
  backHomeText,
  forceAssignText,
  plain,
};
