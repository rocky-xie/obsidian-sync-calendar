import type { App, Notice, TFile } from "obsidian";

import type { Todo } from "TodoSerialization/Todo";
import { debug } from 'lib/DebugLog';
import { GoogleCalendarSync } from './GoogleCalendarSync'
import { ObsidianTasksSync } from './ObsidianTasksSync';
import { REG_DATETIME } from 'lib/DateUtils';

export class MainSynchronizer {
  private app: App;
  private calendarSync: GoogleCalendarSync;
  private obsidianSync: ObsidianTasksSync;

  constructor(app: App) {
    this.app = app;
    this.calendarSync = new GoogleCalendarSync(this.app);
    this.obsidianSync = new ObsidianTasksSync(this.app);
  }

  public isReady(): Promise<boolean> {
    return this.calendarSync.isReady();
  }

  public async pushTodosToCalendar(
    startMoment: moment.Moment,
    maxResults: number = 200,
    triggeredBy: 'auto' | 'mannual' = 'auto'
  ) {
    debug(`[push] ========== pushTodosToCalendar START ==========`);

    const obTasks = await this.obsidianSync.listTasks(startMoment, triggeredBy);
    debug(`[push] obTasks count=${obTasks.length}`);
    obTasks.forEach((task: Todo, idx: number) => {
      debug(`[push] obTask[${idx}]: content="${task.content}", blockId="${task.blockId}", taskId="${task.taskId}", taskListId="${task.taskListId}", syncType="${task.syncType}", startDateTime="${task.startDateTime}", dueDateTime="${task.dueDateTime}", eventStatus="${task.eventStatus}", isEventCandidate=${task.isEventCandidate()}, isTaskCandidate=${task.isTaskCandidate()}`);
    });

    // 1. 预收集所有 Event 和 Task candidates
    const eventCandidates: Todo[] = [];
    const taskCandidates: Todo[] = [];
    for (const task of obTasks) {
      if (task.isEventCandidate() && task.blockId && task.blockId.length > 0) {
        eventCandidates.push(task);
      }
      if (task.isTaskCandidate() && task.blockId && task.blockId.length > 0) {
        taskCandidates.push(task);
      }
    }
    debug(`[push] eventCandidates=${eventCandidates.length}, taskCandidates=${taskCandidates.length}`);

    // 2. Fetch Google data unconditionally (shared between push and pull)
    const clEvents = await this.calendarSync.listEvents(startMoment, maxResults);
    const clTasks = await this.calendarSync.listTasks(startMoment, maxResults);
    debug(`[push] clEvents=${clEvents.length}, clTasks=${clTasks.length}`);

    // Build blockId/taskId maps from Google data
    const clBlockId2Event = new Map<string, Todo>();
    clEvents.forEach((event: Todo) => {
      if (event.blockId && event.blockId.length > 0) {
        clBlockId2Event.set(event.blockId, event);
        debug(`[push] clEvent map: blockId="${event.blockId}", content="${event.content}", eventStatus="${event.eventStatus}"`);
      }
    });

    const clBlockId2Task = new Map<string, Todo>();
    const clTaskId2Task = new Map<string, Todo>();
    clTasks.forEach((task: Todo) => {
      if (task.blockId && task.blockId.length > 0) {
        clBlockId2Task.set(task.blockId, task);
      }
      if (task.taskId) {
        clTaskId2Task.set(task.taskId, task);
      }
      debug(`[push] clTask map: blockId="${task.blockId}", taskId="${task.taskId}", content="${task.content}", eventStatus="${task.eventStatus}", dueDateTime="${task.dueDateTime}"`);
    });

    // 3. Push: Tasks (only if candidates exist)
    debug(`[push] taskCandidates=${taskCandidates.length}`);

    const pulledBlockIds = new Set<string>();
    if (taskCandidates.length > 0) {
      let patchedCount = 0;
      let overriddenCount = 0;
      let insertedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for (const task of taskCandidates) {
        try {
          task.syncType = 'task';
          task.taskListId = '@default';

          let remoteTask: Todo | undefined = undefined;
          let matchType: string = 'none';

          if (task.taskId && clTaskId2Task.has(task.taskId)) {
            remoteTask = clTaskId2Task.get(task.taskId)!;
            matchType = 'taskId';
          } else if (task.blockId && clBlockId2Task.has(task.blockId)) {
            remoteTask = clBlockId2Task.get(task.blockId)!;
            matchType = 'blockId';
          }

          debug(`[push] task "${task.content}": matchType=${matchType}, local eventStatus="${task.eventStatus}", local taskId="${task.taskId}", local blockId="${task.blockId}"`);

          if (remoteTask) {
            debug(`[push] matched remote task: content="${remoteTask.content}", eventStatus="${remoteTask.eventStatus}", taskId="${remoteTask.taskId}", blockId="${remoteTask.blockId}", dueDateTime="${remoteTask.dueDateTime}"`);

            const remoteCompleted = remoteTask.eventStatus === 'x' || remoteTask.eventStatus === 'X';
            const localCompleted = task.eventStatus === 'x' || task.eventStatus === 'X';

            if (remoteCompleted && !localCompleted) {
              if (MainSynchronizer.hasContentOrDateChanges(task, remoteTask)) {
                if (!task.taskId && remoteTask.taskId) {
                  task.taskId = remoteTask.taskId;
                }
                debug(`[push] TASK PUSH OVERRIDE (${matchType}): remote completed, local has changes → push: "${task.content}", taskId="${task.taskId}"`);
                await this.calendarSync.patchTask(task);
                if (task.blockId) pulledBlockIds.add(task.blockId);
                overriddenCount++;
              } else {
                debug(`[push] TASK PULL (${matchType}): remote completed, local no changes → mark Obsidian done: "${task.content}"`);
                task.updateFrom(remoteTask);
                if (remoteTask.taskId) {
                  task.taskId = remoteTask.taskId;
                  task.taskListId = remoteTask.taskListId;
                  task.syncType = 'task';
                }
                await this.obsidianSync.patchTodo(task, ObsidianTasksSync.getStatusDonePatch);
                if (task.blockId) pulledBlockIds.add(task.blockId);
              }
            } else {
              const patchRequired = this.isTaskPatchRequired(task, remoteTask);

              if (patchRequired) {
                if (!task.taskId && remoteTask.taskId) {
                  task.taskId = remoteTask.taskId;
                }

                debug(`[push] TASK PATCH (${matchType}): content="${task.content}", taskId="${task.taskId}", changes="${patchRequired}"`);
                await this.calendarSync.patchTask(task);
                patchedCount++;
              } else {
                debug(`[push] TASK SKIP: no changes detected for "${task.content}", blockId="${task.blockId}", taskId="${task.taskId}"`);
                skippedCount++;
              }
            }
          } else {
            debug(`[push] TASK INSERT: new task "${task.content}"`);
            await this.calendarSync.insertTask(task);
            insertedCount++;
          }
        } catch (e) {
          debug(`[push] ERROR processing task "${task.content}": ${e}`);
          errorCount++;
        }
      }

      debug(`[push] TASK SUMMARY: patched=${patchedCount}, overridden=${overriddenCount}, inserted=${insertedCount}, skipped=${skippedCount}, pulled=${pulledBlockIds.size}, errors=${errorCount}`);
    }

    // 4. Push: Events
    let eventPatched = 0;
    let eventInserted = 0;
    let eventSkipped = 0;

    for (const task of eventCandidates) {
      try {
        task.syncType = 'event';
        debug(`[push] EVENT: content="${task.content}", blockId="${task.blockId}", obStatus="${task.eventStatus}"`);

        if (task.blockId && clBlockId2Event.has(task.blockId)) {
          const event = clBlockId2Event.get(task.blockId)!;
          task.eventId = event.eventId;

          const remoteHasTime = !!(event.startDateTime && REG_DATETIME.test(event.startDateTime));
          const localHasTime = !!(task.startDateTime && REG_DATETIME.test(task.startDateTime));

          if (remoteHasTime !== localHasTime) {
            debug(`[push] EVENT DATE TYPE CHANGED: "${task.content}", remoteHasTime=${remoteHasTime}, localHasTime=${localHasTime} → delete & recreate`);
            await this.calendarSync.deleteEvent(task);
            await this.calendarSync.insertEvent(task);
            eventPatched++;
            continue;
          }

          const patchRequired = this.isEventPatchRequired(task, event);

          if (patchRequired) {
            const needsStatusPrefix = task.eventStatus !== ' ' && task.eventStatus !== '';
            debug(`[push] EVENT PATCH: "${task.content}", changes="${patchRequired}", useStatusPrefix=${needsStatusPrefix}`);
            await this.calendarSync.patchEvent(task, (t) => GoogleCalendarSync.getEventPatch(t, needsStatusPrefix));
            eventPatched++;
          } else {
            debug(`[push] EVENT SKIP: no changes detected for "${task.content}", blockId="${task.blockId}"`);
            eventSkipped++;
          }
        } else {
          debug(`[push] EVENT INSERT: "${task.content}"`);
          await this.calendarSync.insertEvent(task);
          eventInserted++;
        }
      } catch (e) {
        debug(`[push] ERROR processing event "${task.content}": ${e}`);
      }
    }

    if (eventCandidates.length > 0) {
      debug(`[push] EVENT SUMMARY: patched=${eventPatched}, inserted=${eventInserted}, skipped=${eventSkipped} (no changes)`);
    }

    // 5. Pull: Google → Obsidian (reuse fetched data to avoid duplicate API calls)
    if (clEvents.length > 0 || clTasks.length > 0) {
      debug(`[push][pull] ========== PULL (embedded in push) START ==========`);

      const obBlockId2Task = new Map<string, Todo>();
      obTasks.forEach((task: Todo) => {
        if (task.blockId && task.blockId.length > 0) {
          obBlockId2Task.set(task.blockId, task);
        }
      });

      const allCalendarItems = [...clEvents, ...clTasks];
      debug(`[push][pull] allCalendarItems=${allCalendarItems.length}`);

      for (const item of allCalendarItems) {
        debug(`[push][pull] item: content="${item.content}", blockId="${item.blockId}", syncType="${item.syncType}", eventStatus="${item.eventStatus}", taskId="${item.taskId}"`);

        if (!item.blockId || item.blockId.length === 0) {
          debug(`[push][pull] SKIP: no blockId for "${item.content}"`);
          continue;
        }

        if (pulledBlockIds.has(item.blockId)) {
          debug(`[push][pull] SKIP: already pulled in per-task pull, content="${item.content}"`);
          continue;
        }
        if (!obBlockId2Task.has(item.blockId)) {
          debug(`[push][pull] SKIP: blockId "${item.blockId}" not found in Obsidian for "${item.content}"`);
          continue;
        }

        let obTask = obBlockId2Task.get(item.blockId)!;

        if (!obTask.path || !obTask.blockId) {
          debug(`[push][pull] SKIP: cannot find file/blockId for "${item.content}"`);
          continue;
        }

        const obCompleted = (obTask.eventStatus === 'x' || obTask.eventStatus === 'X');
        const gcalCompleted = (item.eventStatus === 'x' || item.eventStatus === 'X');

        debug(`[push][pull] comparing: content="${item.content}", blockId="${item.blockId}", obStatus="${obTask.eventStatus}", gcalStatus="${item.eventStatus}"`);

        if (gcalCompleted && !obCompleted) {
          debug(`[push][pull] SYNC Google→Obsidian: Google completed, Obsidian NOT completed → mark local as done, content="${item.content}", blockId="${item.blockId}"`);
          obTask.updateFrom(item);

          if (item.taskId) {
            obTask.taskId = item.taskId;
            obTask.taskListId = item.taskListId;
            obTask.syncType = 'task';
          }

          await this.obsidianSync.patchTodo(obTask, ObsidianTasksSync.getStatusDonePatch);
          obBlockId2Task.set(item.blockId, obTask);
          continue;
        }

        if (obCompleted && !gcalCompleted) {
          debug(`[push][pull] SKIP (local wins): Obsidian completed, Google NOT completed → push already handled, content="${item.content}"`);
          continue;
        }

        if (obTask.eventStatus === item.eventStatus) {
          debug(`[push][pull] SKIP: status same for "${item.content}", ob="${obTask.eventStatus}", gcal="${item.eventStatus}"`);
          if (item.syncType === 'task' && item.taskId && obTask.taskId !== item.taskId) {
            debug(`[push][pull] TASK ID RECOVERY: obTaskId="${obTask.taskId}" vs gcalTaskId="${item.taskId}" → updating in memory only`);
            obTask.taskId = item.taskId;
            obTask.taskListId = item.taskListId;
            obTask.syncType = 'task';
          }
          continue;
        }

        debug(`[push][pull] SKIP (local wins): other status diff, content="${item.content}", obStatus="${obTask.eventStatus}", gcalStatus="${item.eventStatus}" → push handles this`);
      }

      debug(`[push][pull] ========== PULL (embedded in push) END ==========`);
    }

    debug(`[push] ========== pushTodosToCalendar END ==========`);
  }

  /**
   * 比较本地任务和远程任务，判断是否需要 patch
   */
  private static isSameMoment(a: string | null | undefined, b: string | null | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
      return window.moment(a).isSame(window.moment(b));
    } catch {
      return a === b;
    }
  }

  private static hasContentOrDateChanges(local: Todo, remote: Todo): boolean {
    if (local.content && remote.content && local.content !== remote.content) return true;
    if (!MainSynchronizer.isSameMoment(local.dueDateTime, remote.dueDateTime)) return true;
    return false;
  }

  private static compareTodoChanges(local: Todo, remote: Todo, checkStart: boolean = false): string {
    const changes: string[] = [];

    debug(`[push][compareTodoChanges] comparing local vs remote:
  local.eventStatus="${local.eventStatus}" | remote.eventStatus="${remote.eventStatus}"
  local.content="${local.content}" | remote.content="${remote.content}"
  local.startDateTime="${local.startDateTime}" | remote.startDateTime="${remote.startDateTime}"
  local.dueDateTime="${local.dueDateTime}" | remote.dueDateTime="${remote.dueDateTime}"
  local.doneDateTime="${local.doneDateTime}" | remote.doneDateTime="${remote.doneDateTime}"`);

    if (local.eventStatus !== remote.eventStatus) {
      changes.push(`status: "${remote.eventStatus}" → "${local.eventStatus}"`);
    }

    if (local.content && remote.content && local.content !== remote.content) {
      changes.push(`content changed`);
    }

    if (checkStart && !MainSynchronizer.isSameMoment(local.startDateTime, remote.startDateTime)) {
      changes.push(`start: "${remote.startDateTime}" → "${local.startDateTime}"`);
    }

    if (!MainSynchronizer.isSameMoment(local.dueDateTime, remote.dueDateTime)) {
      changes.push(`due: "${remote.dueDateTime}" → "${local.dueDateTime}"`);
    }

    if (!MainSynchronizer.isSameMoment(local.doneDateTime, remote.doneDateTime)) {
      changes.push(`doneDate: "${remote.doneDateTime}" → "${local.doneDateTime}"`);
    }

    return changes.join('; ');
  }

  private isTaskPatchRequired(local: Todo, remote: Todo): string {
    const changes = MainSynchronizer.compareTodoChanges(local, remote, false);
    debug(`[push][isTaskPatchRequired] changes detected: "${changes}"`);
    return changes;
  }

  private isEventPatchRequired(local: Todo, remote: Todo): string {
    return MainSynchronizer.compareTodoChanges(local, remote, true);
  }

  public async deleteTodo(todo: Todo): Promise<void> {
    debug(`[delete] content="${todo.content}", syncType="${todo.syncType}", taskId="${todo.taskId}", eventId="${todo.eventId}"`);
    await this.obsidianSync.deleteTodo(todo)
      .catch((err) => { throw err; });

    if (todo.syncType === 'task') {
      await this.calendarSync.deleteTask(todo)
        .catch((err) => { throw err; });
    } else {
      await this.calendarSync.deleteEvent(todo)
        .catch((err) => { throw err; });
    }
  }

  public async insertTodo(todo: Todo): Promise<void> {
    debug(`[insert] content="${todo.content}", syncType="${todo.syncType}"`);
    if (todo.syncType === 'task') {
      await this.calendarSync.insertTask(todo)
        .catch((err) => { throw err; });
    } else {
      await this.calendarSync.insertEvent(todo)
        .catch((err) => { throw err; });
    }
  }

  public async patchTodoToDone(todo: Todo): Promise<void> {
    debug(`[patchDone] content="${todo.content}", syncType="${todo.syncType}", taskId="${todo.taskId}", eventId="${todo.eventId}"`);
    todo.eventStatus = 'x';

    await this.obsidianSync.patchTodo(todo, ObsidianTasksSync.getStatusDonePatch)
      .catch((err) => { throw err; });

    if (todo.syncType === 'task') {
      await this.calendarSync.patchTask(todo)
        .catch((err) => { throw err; });
    } else {
      await this.calendarSync.patchEvent(todo, GoogleCalendarSync.getEventDonePatch)
        .catch((err) => { throw err; });
    }
  }

}
