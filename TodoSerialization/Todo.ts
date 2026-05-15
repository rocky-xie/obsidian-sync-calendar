import { debug } from 'lib/DebugLog';
import { REG_DATETIME, REG_DATE, isDatetimeString, toGoogleDueISO, toGoogleCompletedISO } from 'lib/DateUtils';

import type { calendar_v3, tasks_v1 } from 'googleapis';

export class Todo {
  public content: null | string | undefined;

  public priority?: null | string | undefined;
  public tags?: string[] | undefined;

  public startDateTime: null | string | undefined;
  public scheduledDateTime?: null | string | undefined;
  public dueDateTime?: null | string | undefined;
  public doneDateTime?: null | string | undefined;

  public children?: Todo[] | undefined;

  public calUId?: null | string | undefined;
  public eventId?: null | string | undefined;
  public eventStatus?: null | string | undefined;
  public eventHtmlLink?: null | string | undefined;

  public path?: string | undefined;
  public blockId?: null | string | undefined;

  public updated?: null | string | undefined;

  // Google Tasks 相关字段
  public taskId?: null | string;
  public taskListId?: null | string;
  public syncType?: 'event' | 'task';

  constructor({
    content,
    priority,
    tags,
    startDateTime,
    scheduledDateTime,
    dueDateTime,
    doneDateTime,
    children,
    path,
    blockId,
    eventStatus,
    updated,
    calUId,
    eventId,
    eventHtmlLink,
    taskId = undefined,
    taskListId = undefined,
    syncType = undefined
  }: {
    content: null | string | undefined;
    priority?: null | string | undefined;
    tags?: string[] | undefined;
    startDateTime: null | string | undefined;
    scheduledDateTime?: null | string | undefined;
    dueDateTime?: null | string | undefined;
    doneDateTime?: null | string | undefined;
    children?: Todo[] | undefined;
    path?: string | undefined;
    blockId?: null | string | undefined;
    eventStatus?: null | string | undefined;
    updated?: null | string | undefined;
    calUId?: null | string | undefined;
    eventId?: null | string | undefined;
    eventHtmlLink?: null | string | undefined;
    taskId?: null | string | undefined;
    taskListId?: null | string | undefined;
    syncType?: 'event' | 'task';
  }) {
    this.content = content;

    this.priority = priority;
    this.tags = tags;
    this.startDateTime = startDateTime;
    this.scheduledDateTime = scheduledDateTime;
    this.dueDateTime = dueDateTime;
    this.doneDateTime = doneDateTime;

    this.children = children;

    this.path = path;
    this.blockId = blockId;
    this.eventStatus = eventStatus;

    this.calUId = calUId;
    this.eventId = eventId;
    this.eventHtmlLink = eventHtmlLink;

    this.taskId = taskId;
    this.taskListId = taskListId;
    this.syncType = syncType;

    this.updated = updated;
  }
/**
   * Update the current Todo object with the values from another Todo object.
   * @param todo - The Todo object to update from.
   */
  public updateFrom(todo: Todo) {
    if (todo.content !== undefined) { this.content = todo.content; }
    if (todo.priority !== undefined) { this.priority = todo.priority; }
    if (todo.startDateTime !== undefined) { this.startDateTime = todo.startDateTime; }
    if (todo.scheduledDateTime !== undefined) { this.scheduledDateTime = todo.scheduledDateTime; }
    if (todo.dueDateTime !== undefined) { this.dueDateTime = todo.dueDateTime; }
    if (todo.doneDateTime !== undefined) { this.doneDateTime = todo.doneDateTime; }
    if (todo.tags !== undefined) { this.tags = todo.tags; }
    if (todo.children !== undefined) { this.children = todo.children; }
    if (todo.path !== undefined) { this.path = todo.path; }
    if (todo.calUId !== undefined) { this.calUId = todo.calUId; }
    if (todo.eventId !== undefined) { this.eventId = todo.eventId; }
    if (todo.eventStatus !== undefined) { this.eventStatus = todo.eventStatus; }
    if (todo.eventHtmlLink !== undefined) { this.eventHtmlLink = todo.eventHtmlLink; }
    if (todo.updated !== undefined) { this.updated = todo.updated; }
    if (todo.taskId !== undefined) { this.taskId = todo.taskId; }
    if (todo.taskListId !== undefined) { this.taskListId = todo.taskListId; }
    if (todo.syncType !== undefined) { this.syncType = todo.syncType; }
  }

  /**
   * Serialize the Todo object's description into a string.
   * @returns The serialized description string.
   */
  public serializeDescription(): string {
    return JSON.stringify({
      eventStatus: this.eventStatus ? this.eventStatus : ' ',
      blockId: this.blockId,
      priority: this.priority,
      tags: this.tags,
      doneDateTime: this.doneDateTime,
      syncType: this.syncType,
      taskId: this.taskId,
      taskListId: this.taskListId,
    });
  }

  public isEventCandidate(): boolean {
    return !!this.startDateTime && !!this.dueDateTime;
  }

  public isTaskCandidate(): boolean {
    return !this.isEventCandidate() && (!!this.startDateTime || !!this.dueDateTime);
  }

  /**
   * Convert a Todo object to a Google Calendar event object.
   * @param todo - The Todo object to convert.
   * @returns The Google Calendar event object.
   * @throws Error if the Todo object is invalid.
   */
  static toGoogleEvent(todo: Todo): calendar_v3.Schema$Event {
    let todoEvent = {
      'summary': todo.content,
      'description': todo.serializeDescription(),
      'start': {},
      'end': {},
      'reminders': {
        'useDefault': false,
        'overrides': [
          { 'method': 'popup', 'minutes': 10 },
        ],
      },
    } as calendar_v3.Schema$Event;

    let isValidInterval = false;
    if (todo.startDateTime?.match(REG_DATETIME) && todo.dueDateTime?.match(REG_DATETIME)) {
      isValidInterval = true;
    }

    let isValidEvent = false;
    if (isValidInterval) {
      todoEvent.start!.dateTime = todo.startDateTime;
      todoEvent.end!.dateTime = todo.dueDateTime;
      isValidEvent = true;
    } else {
      if (todo.startDateTime) {
        let startDateMatch = todo.startDateTime.match(REG_DATE);
        let endDateMatch = todo.dueDateTime?.match(REG_DATE);
        if (startDateMatch) {
          todoEvent.start!.date = startDateMatch[1];
          todoEvent.end!.date = endDateMatch ? endDateMatch[1] : startDateMatch[1];
          isValidEvent = true;
        } else if (endDateMatch) {
          todoEvent.start!.date = endDateMatch[1];
          todoEvent.end!.date = endDateMatch[1];
        }
      }
    }
    if (isValidEvent) {
      todoEvent.start!.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      todoEvent.end!.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } else {
      throw Error(`Invalid todo->event ${todo.content}`);
    }
    return todoEvent;
  }

  /**
   * Convert a Google Calendar event object to a Todo object.
   * @param eventMeta - The Google Calendar event object to convert.
   * @returns The Todo object.
   * @throws Error if the eventMeta object is invalid.
   */
  static fromGoogleEvent(eventMeta: calendar_v3.Schema$Event): Todo {
    let content = eventMeta.summary;
    let calUId = eventMeta.iCalUID;
    let eventId = eventMeta.id;
    let eventHtmlLink = eventMeta.htmlLink;
    let eventStatus = "";
    let blockId = undefined;
    let priority = undefined;
    let doneDateTime= undefined;
    let startDateTime: string;
    let dueDateTime: string;
    let tags: string[] = [];
    let updated: string | undefined = undefined;

    if (eventMeta.description !== null && eventMeta.description !== undefined) {
      eventMeta.description = eventMeta.description.replace(/<\/?span>/g, '');
      try {
        blockId = JSON.parse(eventMeta.description).blockId;
      } catch (e) { debug(`JSON parse error on ${eventMeta.description}: ${e}`); }
      try {
        priority = JSON.parse(eventMeta.description).priority;
      } catch (e) { debug(`JSON parse error on ${eventMeta.description}: ${e}`); }
      try {
        eventStatus = JSON.parse(eventMeta.description).eventStatus;
      } catch (e) { debug(`JSON parse error on ${eventMeta.description}: ${e}`); }
      try {
        tags = JSON.parse(eventMeta.description).tags;
      } catch (e) { debug(`JSON parse error on ${eventMeta.description}: ${e}`); }
      try {
        doneDateTime = JSON.parse(eventMeta.description).doneDateTime;
      } catch (e) { debug(`JSON parse error on ${eventMeta.description}: ${e}`); }
    }

    if (!eventMeta.start || !eventMeta.end) {
      throw Error("Invalid eventMeta, start/end not exist!");
    }

    if (eventMeta.start!.dateTime === null || eventMeta.start!.dateTime === undefined) {
      startDateTime = window.moment(eventMeta.start!.date).format('YYYY-MM-DD');
    } else {
      startDateTime = window.moment(eventMeta.start!.dateTime).format('YYYY-MM-DD[T]HH:mm:ssZ');
    }

    if (eventMeta.end!.dateTime === null || eventMeta.end!.dateTime === undefined) {
      dueDateTime = window.moment(eventMeta.end!.date).format('YYYY-MM-DD');
    } else {
      dueDateTime = window.moment(eventMeta.end!.dateTime).format('YYYY-MM-DD[T]HH:mm:ssZ');
    }

    if (eventMeta.updated) {
      updated = window.moment(eventMeta.updated).format('YYYY-MM-DD[T]HH:mm:ssZ');
    }

    return new Todo({
      content,
      priority,
      blockId,
      startDateTime,
      dueDateTime,
      doneDateTime,
      calUId,
      eventId,
      eventStatus,
      eventHtmlLink,
      updated,
      tags,
      taskId: undefined,
      taskListId: undefined,
      syncType: 'event'
    });
  }

  static isDatetime(datetimeString: string): boolean {
    return isDatetimeString(datetimeString);
  }

  static momentString(momentString: string, emoji: '🛫' | '⌛' | '🗓'): string {
    if (Todo.isDatetime(momentString)) {
      return `${emoji} ${window.moment(momentString).format("YYYY-MM-DD[@]HH:mm")}`;
    }
    return `${emoji} ${momentString}`;
  }

  public isOverdue(overdueRefer?: moment.Moment): boolean {
    let referMoment = overdueRefer ? overdueRefer : window.moment();

    if (this.dueDateTime) {
      if (Todo.isDatetime(this.dueDateTime)) {
        return referMoment.isAfter(this.dueDateTime);
      } else {
        return referMoment.startOf('day').isAfter(this.dueDateTime);
      }
    }
    return false;
  }

  static toGoogleTask(todo: Todo): tasks_v1.Schema$Task {
    const status = (todo.eventStatus === 'x' || todo.eventStatus === 'X')
      ? 'completed'
      : 'needsAction';

    const due = todo.dueDateTime ? toGoogleDueISO(todo.dueDateTime) : undefined;
    const completed = status === 'completed' ? toGoogleCompletedISO(todo.doneDateTime) : undefined;

    const result: tasks_v1.Schema$Task = {
      title: todo.content,
      notes: todo.serializeDescription(),
      due,
      status,
      ...(completed ? { completed } : {}),
    };

    debug(`[toGoogleTask] content="${todo.content}", blockId="${todo.blockId}", taskId="${todo.taskId}", eventStatus="${todo.eventStatus}", doneDateTime="${todo.doneDateTime}" → status="${status}", due="${due}", completed="${completed}"`);
    return result;
  }

  static fromGoogleTask(taskMeta: tasks_v1.Schema$Task): Todo {
    let content = taskMeta.title;
    let taskId = taskMeta.id;
    let taskListId = '@default';
    let eventStatus = taskMeta.status === 'completed' ? 'x' : ' ';
    let blockId: string | undefined = undefined;
    let priority: string | undefined = undefined;
    let doneDateTime: string | undefined = undefined;
    let startDateTime: null | string = null;
    let dueDateTime: null | string = null;
    let tags: string[] = [];
    let updated: string | undefined = undefined;

    debug(`[fromGoogleTask] raw: id="${taskMeta.id}", title="${content}", status="${taskMeta.status}", due="${taskMeta.due || ''}", notes="${taskMeta.notes ? taskMeta.notes.substring(0, 300) : '(none)'}"`);

    if (taskMeta.notes) {
      try {
        const parsed = JSON.parse(taskMeta.notes);
        blockId = parsed.blockId;
        priority = parsed.priority;
        if (taskMeta.status !== 'completed' && parsed.eventStatus) {
          eventStatus = parsed.eventStatus;
        }
        tags = parsed.tags || [];
        doneDateTime = parsed.doneDateTime;
        if (parsed.taskId) {
          debug(`[fromGoogleTask] recovered taskId from notes: "${parsed.taskId}" (API id="${taskId}")`);
        }
        if (parsed.taskListId) {
          taskListId = parsed.taskListId;
        }
        debug(`[fromGoogleTask] parsed notes: blockId="${blockId}", eventStatus="${eventStatus}", priority="${priority}", syncType="${parsed.syncType || '(none)'}", notesTaskId="${parsed.taskId || '(none)'}"`);
      } catch (e) {
        debug(`[fromGoogleTask] JSON parse error on task notes: ${e}`);
      }
    } else {
      debug(`[fromGoogleTask] task="${content}" has no notes, blockId will be undefined`);
    }

    if (taskMeta.due) {
      dueDateTime = window.moment(taskMeta.due).format('YYYY-MM-DD');
    }

    if (taskMeta.updated) {
      updated = window.moment(taskMeta.updated).format('YYYY-MM-DD[T]HH:mm:ssZ');
    }

    if (taskMeta.completed) {
      doneDateTime = window.moment(taskMeta.completed).format('YYYY-MM-DD');
    }

    debug(`[fromGoogleTask] result: content="${content}", blockId="${blockId}", taskId="${taskId}", taskListId="${taskListId}", eventStatus="${eventStatus}", dueDateTime="${dueDateTime}"`);

    return new Todo({
      content,
      priority,
      blockId,
      startDateTime,
      dueDateTime,
      doneDateTime,
      eventStatus,
      updated,
      tags,
      taskId,
      taskListId,
      syncType: 'task',
    });
  }
}