import * as vscode from "vscode";
import * as httpModule from "http";
import * as httpsModule from "https";
import { outputConsole, currentWorkspaceFolder } from "../utils";
const Cache = require("vscode-cache");
import {
  config,
  extensionContext,
  workspaceState,
  FILESYSTEM_SCHEMA
} from "../extension";
import * as url from "url";
import * as request from "request-promise";

const DEFAULT_API_VERSION: number = 1;
// require("request-promise").debug = true;

export class AtelierAPI {
  private _config: any;
  private _namespace: string;
  private _cache;
  private _workspaceFolder;

  public get ns(): string {
    return this._namespace || this._config.ns;
  }

  private get apiVersion(): number {
    return workspaceState.get(
      this._workspaceFolder + ":apiVersion",
      DEFAULT_API_VERSION
    );
  }

  constructor(wsOrFile?: string | vscode.Uri) {
    let workspaceFolderName: string = "";
    if (wsOrFile) {
      if (wsOrFile instanceof vscode.Uri) {
        if (wsOrFile.scheme === FILESYSTEM_SCHEMA) {
          workspaceFolderName = wsOrFile.authority;
          let query = url.parse(decodeURIComponent(wsOrFile.toString()), true)
            .query;
          if (query) {
            if (query.ns && query.ns !== "") {
              let namespace = query.ns.toString();
              this.setNamespace(namespace);
            }
          }
        }
      } else {
        workspaceFolderName = wsOrFile;
      }
    }
    this.setConnection(workspaceFolderName || currentWorkspaceFolder());
  }

  setNamespace(namespace: string) {
    this._namespace = namespace;
  }

  get cookies(): string[] {
    return this._cache.get("cookies", []);
  }

  updateCookies(newCookies: string[]): Promise<any> {
    let cookies = this._cache.get("cookies", []);
    newCookies.forEach(cookie => {
      let [cookieName] = cookie.split("=");
      let index = cookies.findIndex(el => el.startsWith(cookieName));
      if (index >= 0) {
        cookies[index] = cookie;
      } else {
        cookies.push(cookie);
      }
    });
    return this._cache.put("cookies", cookies);
  }

  setConnection(workspaceFolderName: string) {
    this._workspaceFolder = workspaceFolderName;
    let conn = config("conn", workspaceFolderName);
    this._config = conn;
    const { name, host, port } = this._config;
    this._cache = new Cache(extensionContext, `API:${name}:${host}:${port}`);
  }

  async request(
    minVersion: number,
    method: string,
    path?: string,
    body?: any,
    params?: any,
    headers?: any
  ): Promise<any> {
    if (minVersion > this.apiVersion) {
      return Promise.reject(
        `${path} not supported by API version ${this.apiVersion}`
      );
    }
    if (minVersion && minVersion > 0) {
      path = `v${this.apiVersion}/${path}`;
    }
    if (!this._config.active) {
      return Promise.reject();
    }
    headers = {
      ...headers,
      Accept: "application/json"
    };
    const buildParams = (): string => {
      if (!params) {
        return "";
      }
      let result = [];
      Object.keys(params).forEach(key => {
        let value = params[key];
        if (value && value !== "") {
          if (typeof value === "boolean") {
            value = value ? "1" : "0";
          }
          result.push(`${key}=${value}`);
        }
      });
      return result.length ? "?" + result.join("&") : "";
    };
    method = method.toUpperCase();
    if (["PUT", "POST"].includes(method) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    headers["Cache-Control"] = "no-cache";

    const { host, port, username, password, https } = this._config;
    const proto = this._config.https ? "https" : "http";
    const http: any = this._config.https ? httpsModule : httpModule;
    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: 10,
      rejectUnauthorized: https && config("http.proxyStrictSSL")
    });
    path = encodeURI(`/api/atelier/${path || ""}${buildParams()}`);

    // if (headers["Content-Type"] && headers["Content-Type"].includes("json")) {
    //   body = JSON.stringify(body);
    // }

    // console.log(`APIRequest: ${method} ${proto}://${host}:${port}${path}`)

    let cookies = this.cookies;
    let auth;
    if (cookies.length || method === 'HEAD') {
      auth = Promise.resolve(cookies);
    } else if (!cookies.length) {
      auth = this.request(0, 'HEAD')
    }
    return auth.then((cookies) => {
      // console.log('cookies', cookies);
      return request({
        // jar: cookieJar,
        uri: `${proto}://${host}:${port}${path}`,
        method,
        agent,
        auth: { username, password, sendImmediately: false },
        headers: {
          ...headers,
          Cookie: cookies
        },
        body: ["PUT", "POST"].includes(method) ? body : null,
        json: true,
        resolveWithFullResponse: true,
        simple: true
      })
        // .catch(error => error.error)
        .then(response => this.updateCookies(response.headers["set-cookie"]).then(() => response))
        .then(response => {
          // console.log(`APIResponse: ${method} ${proto}://${host}:${port}${path}`)
          if (method === 'HEAD') {
            return this.cookies
          }
          let data = response.body;
          if (data.console) {
            outputConsole(data.console);
          }
          if (data.status.summary) {
            throw new Error(data.status.summary);
          } else if (data.result.status) {
            throw new Error(data.result.status);
          } else {
            return data
          }
        })
    });
  }

  serverInfo(): Promise<any> {
    return this.request(0, "GET")
      .then(info => {
        if (
          info &&
          info.result &&
          info.result.content &&
          info.result.content.api > 0
        ) {
          let data = info.result.content;
          let apiVersion = data.api;
          if (!data.namespaces.includes(this.ns)) {
            throw {
              code: "WrongNamespace",
              message: "This server does not have specified namespace."
            };
          }
          return workspaceState
            .update(currentWorkspaceFolder() + ":apiVersion", apiVersion)
            .then(() => info);
        }
      });
  }
  // api v1+
  getDocNames({
    generated = false,
    category = "*",
    type = "*",
    filter = ""
  }: {
    generated?: boolean;
    category?: string;
    type?: string;
    filter?: string;
  }): Promise<any> {
    return this.request(
      1,
      "GET",
      `${this.ns}/docnames/${category}/${type}`,
      null,
      {
        filter,
        generated
      }
    );
  }
  // api v1+
  getDoc(name: string, format?: string): Promise<any> {
    let params = {};
    if (format) {
      params = {
        format
      };
    }
    return this.request(1, "GET", `${this.ns}/doc/${name}`, params);
  }
  // api v1+
  deleteDoc(name: string): Promise<any> {
    return this.request(1, "DELETE", `${this.ns}/doc/${name}`);
  }
  // v1+
  putDoc(
    name: string,
    data: { enc: boolean; content: string[] },
    ignoreConflict?: boolean
  ): Promise<any> {
    let params = { ignoreConflict };
    return this.request(1, "PUT", `${this.ns}/doc/${name}`, data, params);
  }
  // v1+
  actionIndex(docs: string[]): Promise<any> {
    return this.request(1, "POST", `${this.ns}/action/index`, docs);
  }
  // v2+
  actionSearch(params: {
    query: string;
    files?: string;
    sys?: boolean;
    gen?: boolean;
    max?: number;
  }): Promise<any> {
    return this.request(2, "GET", `${this.ns}/action/search`, null, params);
  }
  // v1+
  actionQuery(query: string, parameters: string[]): Promise<any> {
    // outputChannel.appendLine('SQL: ' + query);
    // outputChannel.appendLine('SQLPARAMS: ' + JSON.stringify(parameters));
    return this.request(1, "POST", `${this.ns}/action/query`, {
      query,
      parameters
    });
  }
  // v1+
  actionCompile(docs: string[], flags?: string, source = false): Promise<any> {
    return this.request(1, "POST", `${this.ns}/action/compile`, docs, {
      flags,
      source
    });
  }

  cvtXmlUdl(source: string): Promise<any> {
    return this.request(
      1,
      "POST",
      `${this.ns}/`,
      source,
      {},
      { "Content-Type": "application/xml" }
    );
  }
  // v2+
  getmacrodefinition(docname: string, macroname: string, includes: string[]) {
    return this.request(2, "POST", `${this.ns}/action/getmacrodefinition`, {
      docname,
      macroname,
      includes
    });
  }
  // v2+
  getmacrolocation(docname: string, macroname: string, includes: string[]) {
    return this.request(2, "POST", `${this.ns}/action/getmacrolocation`, {
      docname,
      macroname,
      includes
    });
  }
  // v2+
  getmacrollist(docname: string, includes: string[]) {
    return this.request(2, "POST", `${this.ns}/action/getmacrolist`, {
      docname,
      includes
    });
  }
}
