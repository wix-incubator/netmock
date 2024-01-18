import { ClientRequestArgs, OutgoingHttpHeaders } from 'http';
import {
  captureStack, getErrorWithCorrectStack, getRequestMethodForHttp, getUrlForHttp,
} from './utils';
import { findMockedEndpointForHttp, findMockedMethodForHttp, getMockedEndpointMetadata } from './mockedEndpointsService';
import { isRealNetworkAllowed } from './settings';
import { Headers, NetmockResponseType } from './types';
import { isInstanceOfNetmockResponse } from './NetmockResponse';

export function httpRequest(request: ClientRequestArgs & { query?: string, body?: any, search?: string }, cb?: CallBack, isHttpsRequest?: boolean) {
  try {
    const originalModule = isHttpsRequest ? global.originalHttps : global.originalHttp;
    const func = originalModule.request;
    const url = decodeURI(getUrlForHttp(request));
    const method = getRequestMethodForHttp(request);
    const mockedEndpoint = findMockedEndpointForHttp(request, method);
    if (!mockedEndpoint) {
      if (isRealNetworkAllowed(url)) {
        return func(request, cb);
      }
      let message = `Endpoint not mocked: ${method.toUpperCase()} ${url}`;
      const mockedMethods = findMockedMethodForHttp(request);
      if (mockedMethods.length > 0) {
        message += `\nThe request is of type ${method.toUpperCase()} but netmock could only find mocks for ${mockedMethods.map((value) => value.toUpperCase()).join(',')}`;
      }

      throw getErrorWithCorrectStack(message, captureStack(func));
    }
    const headers = getHeaders(request.headers);
    const query = parseQuery(request.query || request.search);
    const params = url.match(mockedEndpoint.urlRegex)?.groups ?? {};
    const body = request.body;

    const metadata = getMockedEndpointMetadata(method, url);

    let res = mockedEndpoint.handler({
      // @ts-ignore
      rawRequest: new Request(request), query, params, headers, body,
    }, { callCount: metadata?.calls.length }) || '';
    if (typeof res === 'object' && !isPromise(res) && !isInstanceOfNetmockResponse(res)) {
      res = JSON.stringify(res);
    }
    let responseObject: ResponseObject = {
      headers: {},
      location: 'BLA',
      statusCode: 200,
      once: () => {},
      pipe: () => getResStr(res),
    };
    const finalResponse = {
      ...responseObject,
      on: async (eventName: string, onCB: CallBack) => {
        console.log(`eventName: ${eventName}`);
        res = isPromise(res) ? await res : res;
        responseObject = convertResponse(responseObject, res);
        let returnValue;
        if (eventName === 'data') {
          returnValue = getResStr(res);
        } else if (eventName === 'response') {
          await wait(getDelay(res));
          returnValue = responseObject;
        } else {
          returnValue = { emit: () => {} };
        }
        if (!['aborted', 'error', 'abort', 'connect', 'socket', 'timeout'].includes(eventName)) {
          onCB(returnValue);
          return returnValue;
        }
      },
      destroy: (onCb: any) => { onCb(null); },
      end: () => { },
    };
    if (cb) {
      setTimeout(async () => {
        res = isPromise(res) ? await res : res;
        responseObject = convertResponse(responseObject, res);
        cb({ ...finalResponse, ...responseObject });
      }, getDelay(res));
    }
    return finalResponse;
  } catch (e) {
    return Promise.reject(e);
  }
}

function stringifyWithOneLevel(obj: any) {
  const seen = new WeakSet();

  function replacer(key: any, value: any) {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular Reference]';
      }
      seen.add(value);
    }
    return value;
  }

  return JSON.stringify(obj, replacer);
}

function parseQuery(queryString?: string) {
  if (!queryString) {
    return '';
  }
  const query: { [key: string]: string } = {};
  const pairs = (queryString[0] === '?' ? queryString.substr(1) : queryString).split('&');
  pairs.forEach((item) => {
    const pair = item.split('=');
    query[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1] || '');
  });
  return query;
}
function getHeaders(originalHeaders?: OutgoingHttpHeaders) {
  const initialHeaders = originalHeaders || {};
  return Object.keys(initialHeaders).reduce((prev, cur) => ({ ...prev, [cur]: initialHeaders[cur]?.toString() }), {});
}

function isPromise(obj: any) {
  return obj instanceof Promise;
}

function convertResponse<T>(originalResponse: ResponseObject, response: NetmockResponseType<T>) {
  if (isInstanceOfNetmockResponse(response)) {
    const netmockRes = response.getResponseParams();
    return {
      ...originalResponse,
      statusCode: netmockRes.status,
      statusMessage: netmockRes.statusText,
      ...(response.getResponseParams()),
      data: response.stringifyBody(),
    };
  }
  return {
    ...originalResponse,
    data: response,
  };
}

function getResStr(res: any) {
  return isInstanceOfNetmockResponse(res) ? (res as NetmockResponseType<string>).stringifyBody() : res;
}

function getDelay(res: any) {
  return isInstanceOfNetmockResponse(res) ? (res as NetmockResponseType<any>).getResponseParams().delay : 0;
}

function wait(time: number) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, time);
  });
}
