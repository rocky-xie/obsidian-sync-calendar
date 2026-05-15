import * as path from 'path';

import type { App, Vault, Notice, FileSystemAdapter } from 'obsidian';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';
import type { OAuth2Client, GaxiosPromise, GaxiosResponse } from 'googleapis-common';
import type { calendar_v3, tasks_v1 } from 'googleapis';

import { Todo } from 'TodoSerialization/Todo';
import { debug } from 'lib/DebugLog';
import { EVENT_STATUS_PREFIX } from 'lib/Constants';
import { retryOperation } from 'lib/RetryUtils';
import { REG_DATETIME, REG_DATE, toGoogleDueISO, toGoogleCompletedISO } from 'lib/DateUtils';

import {
  NetworkStatus,
  SyncStatus,
  gfSyncStatus$,
  gfNetStatus$
} from './StatusEnumerate';

/**
 * This class handles syncing with Google Calendar.
 */
export class GoogleCalendarSync {
  vault: Vault;

  public SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks'
  ];
  private TOKEN_PATH = ""
  private CREDENTIALS_PATH = ""

  private isTokenValid = true;
  private isTokenRefreshing = false;
  private refreshPromise: Promise<OAuth2Client> | null = null;

  constructor(app: App) {
    this.vault = app.vault

    // Set the paths for the token and credentials files
    this.TOKEN_PATH = path.join(this.vault.configDir, 'calendar.sync.token.json');
    this.CREDENTIALS_PATH = path.join(this.vault.configDir, 'calendar.sync.credentials.json');
  }

  /**
   * Returns a list of completed and uncompleted events.
   * @param startMoment The start moment for the events to retrieve.
   * @param maxResults The maximum number of results to retrieve.
   * @returns A Promise that resolves to an array of Todo objects.
   */
  async listEvents(startMoment: moment.Moment, maxResults: number = 200): Promise<Todo[]> {
    let auth = await this.authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    // Set the sync and network status to DOWNLOAD
    gfSyncStatus$.next(SyncStatus.DOWNLOAD);

    // Retrieve the events from Google Calendar
    const eventsListQueryResult =
      await calendar.events
        .list({
          calendarId: 'primary',
          timeMin: startMoment.toISOString(),
          maxResults: maxResults,
          singleEvents: true,
          orderBy: 'startTime',
        })
        .catch(err => {
          if (err.message == 'invalid_grant') {
            this.isTokenValid = false;
          }
          // Set the network status to CONNECTION_ERROR and the sync status to FAILED_WARNING
          gfNetStatus$.next(NetworkStatus.CONNECTION_ERROR);
          gfSyncStatus$.next(SyncStatus.FAILED_WARNING);
          throw err;
        });

    // Set the network status to HEALTH and the sync status to SUCCESS_WAITING
    gfNetStatus$.next(NetworkStatus.HEALTH);
    gfSyncStatus$.next(SyncStatus.SUCCESS_WAITING);

    let eventsMetaList = eventsListQueryResult.data.items;
    let eventsList: Todo[] = [];

    if (eventsMetaList != undefined) {
      eventsMetaList.forEach((eventMeta: calendar_v3.Schema$Event) => {
        eventsList.push(Todo.fromGoogleEvent(eventMeta));
      });
    }

    return eventsList;
  }

  /**
   * Inserts a new event into Google Calendar.
   * @param todo The Todo object to insert.
   */
  async insertEvent(todo: Todo) {
    let auth = await this.authorize();
    const calendar: calendar_v3.Calendar = google.calendar({ version: 'v3', auth });

    await retryOperation(
      () => calendar.events.insert({
        auth: auth,
        calendarId: 'primary',
        resource: Todo.toGoogleEvent(todo)
      } as calendar_v3.Params$Resource$Events$Insert),
      (event) => {
        debug(`Added event: ${todo.content}! link: ${event.data.htmlLink}`);
      },
      `insert event: ${todo.content}`
    );
  }

  /**
   * Deletes an event from Google Calendar.
   * @param todo The Todo object to delete.
   */
  async deleteEvent(todo: Todo): Promise<void> {
    let auth = await this.authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    await retryOperation(
      () => calendar.events.delete({
        auth: auth,
        calendarId: 'primary',
        eventId: todo.eventId
      } as calendar_v3.Params$Resource$Events$Delete),
      () => {
        debug(`Deleted event: ${todo.content}!`);
      },
      `delete event: ${todo.content}`
    );
  }

  /**
   * Patches an event in Google Calendar.
   * @param todo The Todo object to patch.
   * @param getEventPatch A function that returns the patch to apply to the event.
   */
  async patchEvent(todo: Todo, getEventPatch: (todo: Todo) => calendar_v3.Schema$Event): Promise<void> {
    let auth = await this.authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    const resource = getEventPatch(todo);
    console.log(`[sync-calendar] PATCH resource: ${JSON.stringify(resource)}`);
    debug(`[patchEvent] resource="${JSON.stringify(resource)}"`);

    await retryOperation(
      () => calendar.events.patch({
        auth: auth,
        calendarId: 'primary',
        eventId: todo.eventId!,
        resource,
      } as calendar_v3.Params$Resource$Events$Patch),
      () => {
        debug(`Patched event: ${todo.content}!`);
      },
      `patch event: ${todo.content}`
    );
  }

  /**
     * Returns a patch object for a completed event in Google Calendar.
     * @param todo The Todo object to patch.
     * @returns {calendar_v3.Schema$Event} The patch object.
     */
  static getEventDonePatch(todo: Todo): calendar_v3.Schema$Event {
    return GoogleCalendarSync.getEventPatch(todo, true);
  }

  static getEventPatch(todo: Todo, useStatusPrefix: boolean = false): calendar_v3.Schema$Event {
    const eventDescUpdate = todo.serializeDescription();

    let summary = todo.content || '';

    if (useStatusPrefix) {
      if (!todo.eventStatus) {
        todo.eventStatus = 'x';
      }
      const statusChars = ['!', '?', '>', '-', ' '];
      if (statusChars.indexOf(todo.eventStatus) < 0) {
        todo.eventStatus = 'x';
      }

      switch (todo.eventStatus) {
        case '-': summary = `${EVENT_STATUS_PREFIX.CANCELLED} ${todo.content}`; break;
        case '!': summary = `${EVENT_STATUS_PREFIX.IMPORTANT} ${todo.content}`; break;
        case '>': summary = `${EVENT_STATUS_PREFIX.DEFERRED} ${todo.content}`; break;
        case '?': summary = `${EVENT_STATUS_PREFIX.QUESTION} ${todo.content}`; break;
        case 'x':
        case 'X': summary = `${EVENT_STATUS_PREFIX.DONE} ${todo.content}`; break;
        default: summary = `${EVENT_STATUS_PREFIX.DONE} ${todo.content}`; break;
      }
    }

    const patch: calendar_v3.Schema$Event = {
      summary,
      description: eventDescUpdate,
    };

    if (todo.startDateTime && todo.dueDateTime) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

      if (REG_DATETIME.test(todo.startDateTime) && REG_DATETIME.test(todo.dueDateTime)) {
        patch.start = { dateTime: todo.startDateTime, timeZone: tz };
        patch.end = { dateTime: todo.dueDateTime, timeZone: tz };
      } else if (todo.startDateTime || todo.dueDateTime) {
        const startMatch = todo.startDateTime.match(REG_DATE);
        const endMatch = todo.dueDateTime.match(REG_DATE);
        if (startMatch) {
          patch.start = { date: startMatch[1], timeZone: tz };
          patch.end = { date: endMatch ? endMatch[1] : startMatch[1], timeZone: tz };
        } else if (endMatch) {
          patch.start = { date: endMatch[1], timeZone: tz };
          patch.end = { date: endMatch[1], timeZone: tz };
        }
      }
    }

    return patch;
  }

  /**
   * Checks if the client is authorized to call APIs.
   * @returns {Promise<boolean>} Whether the client is authorized.
   */
  async isReady(): Promise<boolean> {
    if (this.isTokenRefreshing) {
      return false;
    }

    const client = await this.loadSavedCredentialsIfExist();
    if (!client) {
      return false;
    }
    
    return true;
  }

  /**
   * Reads previously authorized credentials from the save file.
   * @returns {Promise<OAuth2Client|null>} The authorized client or null if not found.
   */
  async loadSavedCredentialsIfExist() {
    try {
      const content = await this.vault.adapter.read(this.TOKEN_PATH);
      const credentials = JSON.parse(content);
      return google.auth.fromJSON(credentials);
    } catch (err) {
      return null;
    }
  }

  /**
   * Serializes credentials to a file compatible with GoogleAUth.fromJSON.
   * @param {OAuth2Client} client The client to serialize.
   * @returns {Promise<void>}
   */
  async saveCredentials(client: OAuth2Client) {
    const content = await this.vault.adapter.read(this.CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;

    const payload = JSON.stringify({
      type: 'authorized_user',
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    });
    await this.vault.adapter.write(this.TOKEN_PATH, payload);
  }

  /**
   * Load or request authorization to call APIs.
   * @returns {Promise<OAuth2Client>} The authorized client.
   */
  public async authorize(): Promise<OAuth2Client> {
    if (this.isTokenValid) {
      const client = await this.loadSavedCredentialsIfExist() as OAuth2Client;
      if (client) {
        return client;
      }
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.isTokenRefreshing = true;
    this.refreshPromise = this.doRefresh();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
      this.isTokenRefreshing = false;
    }
  }

  private async doRefresh(): Promise<OAuth2Client> {
    const fs_adapter = this.vault.adapter as FileSystemAdapter;
    const KEY_FILE = fs_adapter.getFullPath(this.CREDENTIALS_PATH);
    const client = await authenticate({
      scopes: this.SCOPES,
      keyfilePath: KEY_FILE,
    });

    if (client.credentials) {
      await this.saveCredentials(client);
    }
    this.isTokenValid = true;
    return client;
  }

  static getTaskPatch(todo: Todo): tasks_v1.Schema$Task {
    const status = (todo.eventStatus === 'x' || todo.eventStatus === 'X')
      ? 'completed'
      : 'needsAction';

    const completed = status === 'completed' ? toGoogleCompletedISO(todo.doneDateTime) : undefined;
    const due = todo.dueDateTime ? toGoogleDueISO(todo.dueDateTime) : undefined;

    debug(`[getTaskPatch] content="${todo.content}", eventStatus="${todo.eventStatus}", doneDateTime="${todo.doneDateTime}", dueDateTime="${todo.dueDateTime}" → status="${status}", completed="${completed}", due="${due}"`);

    return {
      title: todo.content,
      notes: todo.serializeDescription(),
      status,
      ...(completed ? { completed } : {}),
      ...(due ? { due } : {}),
    };
  }

  async insertTask(todo: Todo) {
    debug(`[insertTask] content="${todo.content}", blockId="${todo.blockId}", eventStatus="${todo.eventStatus}", dueDateTime="${todo.dueDateTime}"`);
    let auth = await this.authorize();
    const tasks = google.tasks({ version: 'v1', auth });

    const requestBody = Todo.toGoogleTask(todo);
    debug(`[insertTask] requestBody: title="${requestBody.title}", due="${requestBody.due}", status="${requestBody.status}"`);

    await retryOperation(
      () => tasks.tasks.insert({
        tasklist: '@default',
        requestBody,
      }),
      (result) => {
        const apiId = result.data.id;
        const apiTitle = result.data.title;
        const apiStatus = result.data.status;
        const apiDue = result.data.due;
        const apiNotes = result.data.notes;
        todo.taskId = apiId;
        todo.taskListId = '@default';
        todo.syncType = 'task';
        debug(`[insertTask] SUCCESS: content="${todo.content}", response: id="${apiId}", title="${apiTitle}", status="${apiStatus}", due="${apiDue || '(none)'}", notesPresent=${!!apiNotes}`);
      },
      `insert task: ${todo.content}`
    );

    // Verify the task was actually persisted by re-fetching
    try {
      const verifyResult = await tasks.tasks.get({
        tasklist: '@default',
        task: todo.taskId!,
      });
      debug(`[insertTask] VERIFY: task "${todo.content}" (id="${todo.taskId}") found in Google: title="${verifyResult.data.title}", status="${verifyResult.data.status}"`);
    } catch (e) {
      debug(`[insertTask] VERIFY FAILED: task "${todo.content}" (id="${todo.taskId}") NOT found in Google after insert! error=${e}`);
    }
  }

  async patchTask(todo: Todo): Promise<void> {
    debug(`[patchTask] content="${todo.content}", taskId="${todo.taskId}", taskListId="${todo.taskListId}", eventStatus="${todo.eventStatus}"`);
    if (!todo.taskId) {
      debug(`[patchTask] ERROR: No taskId for task "${todo.content}"`);
      throw Error(`No taskId for task: ${todo.content}`);
    }

    let auth = await this.authorize();
    const tasks = google.tasks({ version: 'v1', auth });

    const requestBody = GoogleCalendarSync.getTaskPatch(todo);
    debug(`[patchTask] taskId="${todo.taskId}", requestBody="${JSON.stringify(requestBody)}"`);

    await retryOperation(
      () => tasks.tasks.patch({
        tasklist: todo.taskListId || '@default',
        task: todo.taskId!,
        requestBody: requestBody,
      }),
      () => {
        debug(`[patchTask] SUCCESS: content="${todo.content}", taskId="${todo.taskId}"`);
      },
      `patch task: ${todo.content}`
    );
  }

  async deleteTask(todo: Todo): Promise<void> {
    if (!todo.taskId) {
      throw Error(`No taskId for task: ${todo.content}`);
    }

    let auth = await this.authorize();
    const tasks = google.tasks({ version: 'v1', auth });

    await retryOperation(
      () => tasks.tasks.delete({
        tasklist: todo.taskListId || '@default',
        task: todo.taskId!,
      }),
      () => {
        debug(`Deleted task: ${todo.content}!`);
      },
      `delete task: ${todo.content}`
    );
  }

  async listTasks(startMoment: moment.Moment, maxResults: number = 200): Promise<Todo[]> {
    let auth = await this.authorize();
    const tasks = google.tasks({ version: 'v1', auth });

    gfSyncStatus$.next(SyncStatus.DOWNLOAD);

    const taskListResult = await tasks.tasks
      .list({
        tasklist: '@default',
        maxResults: maxResults,
        showCompleted: true,
        showHidden: true,
      })
      .catch(err => {
        gfNetStatus$.next(NetworkStatus.CONNECTION_ERROR);
        gfSyncStatus$.next(SyncStatus.FAILED_WARNING);
        throw err;
      });

    gfNetStatus$.next(NetworkStatus.HEALTH);
    gfSyncStatus$.next(SyncStatus.SUCCESS_WAITING);

    let taskList: Todo[] = [];
    if (taskListResult.data.items) {
      debug(`[listTasks] raw items count=${taskListResult.data.items.length}`);
      taskListResult.data.items.forEach((taskMeta: tasks_v1.Schema$Task) => {
        debug(`[listTasks] raw: id="${taskMeta.id}", title="${taskMeta.title}", status="${taskMeta.status}", notes="${taskMeta.notes ? taskMeta.notes.substring(0, 200) : '(none)'}", due="${taskMeta.due || '(none)'}", completed="${taskMeta.completed || '(none)'}"`);
        const todo = Todo.fromGoogleTask(taskMeta);
        debug(`[listTasks] parsed: content="${todo.content}", blockId="${todo.blockId}", taskId="${todo.taskId}", taskListId="${todo.taskListId}", eventStatus="${todo.eventStatus}", dueDateTime="${todo.dueDateTime}"`);
        if (todo.dueDateTime) {
          const dueMoment = Todo.isDatetime(todo.dueDateTime)
            ? window.moment(todo.dueDateTime)
            : window.moment(todo.dueDateTime, 'YYYY-MM-DD');
          debug(`[listTasks] filter: dueDateTime="${todo.dueDateTime}", dueMoment=${dueMoment.format()}, startMoment=${startMoment.format()}, isBefore=${dueMoment.isBefore(startMoment)}, keep=${!dueMoment.isBefore(startMoment)}`);
          if (!dueMoment.isBefore(startMoment)) {
            taskList.push(todo);
          } else {
            debug(`[listTasks] FILTERED OUT by date: content="${todo.content}", dueDateTime="${todo.dueDateTime}"`);
          }
        } else {
          debug(`[listTasks] NO DUE DATE: content="${todo.content}", including anyway`);
          taskList.push(todo);
        }
      });
    }
    debug(`[listTasks] returning ${taskList.length} tasks`);
    taskList.forEach((t, i) => {
      debug(`[listTasks] result[${i}]: content="${t.content}", blockId="${t.blockId}", taskId="${t.taskId}", eventStatus="${t.eventStatus}"`);
    });

    return taskList;
  }

}