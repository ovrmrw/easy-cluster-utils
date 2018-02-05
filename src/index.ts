import * as cluster from 'cluster';
import { Worker } from 'cluster';
import * as path from 'path';
import * as fs from 'fs';
import { cpus } from 'os';
import { Subject, Observable } from 'rxjs/Rx';

let worker: string = '';
try {
  const packageJson: string = fs.readFileSync(path.join(path.resolve(), 'package.json')).toString();
  worker = JSON.parse(packageJson).worker;
  if (!worker) {
    throw new Error('"worker" property is not defined in package.json');
  }
} catch (err) {
  throw err;
}

////////////////////////////////////////////////////////////
// settings
const numCPUs: number = cpus().length;
const workerScriptPath: string = worker;


////////////////////////////////////////////////////////////
// for worker.js
export const isWorker: boolean = cluster.isWorker;

export function sendToMaster<T>(obj: ResultMessage<T>): void {
  if (!cluster.isWorker) {
    throw new Error('sendToMaster is called on the master thread.');
  }
  if (process.send) {
    process.send(obj, null);
  }
}


////////////////////////////////////////////////////////////
// for master.js
export const isMaster: boolean = cluster.isMaster;

export class ClusterMaster<R> {
  private workers: WorkerWrapper<R[]>[] = [];

  constructor(options?: Options) {
    this.connectWorkers(options);
  }

  executeList<T>(list: T[], type: string): Promise<R[]> {
    this.workers.forEach((worker, index) => {
      const [from, to] = this.getFromTo(index, list.length);
      const message = {
        type,
        payload: list.slice(from, to)
      };
      worker.sendToWorker(message);
    });

    return Observable
      .forkJoin(this.workers.map(worker => worker.nextState$()))
      .map(flatten)
      .toPromise();
  }

  connectWorkers(options?: Options): void {
    this.workers = createWorkerWrappers<R[]>(options);
  }

  disconnectWorkers(): void {
    this.workers.forEach(worker => worker.disconnect());
  }

  private getFromTo(index: number, listLength: number): [number, number] {
    const block: number = Math.round(listLength / this.workers.length);
    const from: number = index * block;
    const to: number = index === this.workers.length - 1 ? listLength : from + block;
    return [from, to];
  }
}


////////////////////////////////////////////////////////////
// WorkerWrapper
export class WorkerWrapper<R> {
  private subject = new Subject<R>();

  constructor(private _worker: Worker, private options: Options = {}) {
    cluster.on('fork', (worker) => {
      if (this._worker.process.pid === worker.process.pid) {
        this.debug(`worker:${worker.process.pid} started.`);
      }
    });
    cluster.on('message', (worker, message: ResultMessage<any>, handle) => {
      if (this._worker.process.pid === worker.process.pid) {
        this.subject.next(message.result || message);
        this.debug(`result-message from worker:${worker.process.pid}.`, message);
      }
    });
    cluster.on('error', (err) => this.subject.error(err));
    cluster.on('exit', (worker, code, signal) => {
      if (this._worker.process.pid === worker.process.pid) {
        this.subject.complete();
        this.debug(`worker:${worker.process.pid} died.`);
      }
    });
  }

  sendToWorker<T>(message: CommandMessage<T>): void {
    if (!cluster.isMaster) {
      throw new Error('sendToWorker is called on a worker thread.');
    }
    this._worker.send(message, null, err => {
      this.debug(`command-message to worker:${this._worker.process.pid}.`, message);
      if (err) {
        throw err;
      }
    });
  }

  disconnect(): void {
    this._worker.disconnect();
  }

  nextState$(): Observable<R> {
    return this.subject.take(1);
  }

  private debug(...messages: any[]): void {
    if (this.options.debug) {
      console.log(...messages);
    }
  }
}


////////////////////////////////////////////////////////////
// global functions
export function createWorkerWrappers<R>(options?: Options): WorkerWrapper<R>[] {
  if (!cluster.isMaster) {
    return [];
  }
  cluster.setupMaster({
    exec: workerScriptPath
  });

  const workers: WorkerWrapper<R>[] = [];
  for (let i = 0; i < numCPUs; i++) {
    const worker: Worker = cluster.fork();
    workers.push(new WorkerWrapper(worker, options));
  }
  return workers;
}

export function terminate(): void {
  cluster.disconnect();
}


////////////////////////////////////////////////////////////
// helper functions
function flatten<T>(nestedArray: T[][]): T[] {
  return Array.prototype.concat.apply([], nestedArray);
}


////////////////////////////////////////////////////////////
// types
export interface CommandMessage<T> {
  type: string;
  payload: T;
}

export interface ResultMessage<T> {
  result: T;
}

export interface Options {
  debug?: boolean;
}
