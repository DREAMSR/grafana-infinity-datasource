import { Observable } from 'rxjs';
import { flatten, sample } from 'lodash';
import { DataQueryResponse, DataQueryRequest, LoadingState, TimeRange, ScopedVars, toDataFrame, DataFrame } from '@grafana/data';
import { DataSourceWithBackend } from '@grafana/runtime';
import { AnnotationsEditor } from './editors/annotation.editor';
import { InfinityProvider } from './app/InfinityProvider';
import { applyUQL } from './app/UQLProvider';
import { applyGroq } from './app/GROQProvider';
import { SeriesProvider } from './app/SeriesProvider';
import { getUpdatedDataRequest } from './app/queryUtils';
import { LegacyVariableProvider, getTemplateVariablesFromResult, migrateLegacyQuery } from './app/variablesQuery';
import { interpolateQuery, interpolateVariableQuery } from './interpolate';
import { migrateQuery } from './migrate';
import { InfinityQuery, VariableQuery, MetricFindValue, InfinityInstanceSettings, InfinityOptions } from './types';

export class Datasource extends DataSourceWithBackend<InfinityQuery, InfinityOptions> {
  constructor(public instanceSettings: InfinityInstanceSettings) {
    super(instanceSettings);
    this.annotations = {
      QueryEditor: AnnotationsEditor,
    };
  }
  query(options: DataQueryRequest<InfinityQuery>): Observable<DataQueryResponse> {
    return new Observable<DataQueryResponse>((subscriber) => {
      let request = getUpdatedDataRequest(options, this.instanceSettings);
      super
        .query(request)
        .toPromise()
        .then((result) => this.getResults(request, result))
        .then((result) => subscriber.next({ ...result, state: LoadingState.Done }))
        .catch((error) => {
          subscriber.next({ data: [], error, state: LoadingState.Error });
          subscriber.error(error);
        })
        .finally(() => subscriber.complete());
    });
  }
  metricFindQuery(originalQuery: VariableQuery): Promise<MetricFindValue[]> {
    let query = migrateLegacyQuery(originalQuery);
    query = interpolateVariableQuery(query);
    return new Promise((resolve) => {
      switch (query.queryType) {
        case 'random':
          if (query.values && query.values.length > 0) {
            const solvedValue = sample(query.values || []) || query.values[0];
            resolve([{ text: solvedValue, value: solvedValue, label: solvedValue }]);
          } else {
            const solvedValue = new Date().getTime().toString();
            resolve([{ text: solvedValue, value: solvedValue, label: solvedValue }]);
          }
          break;
        case 'infinity':
          if (query.infinityQuery) {
            const updatedQuery = migrateQuery(query.infinityQuery);
            const request = { targets: [interpolateQuery(updatedQuery, {})] } as DataQueryRequest<InfinityQuery>;
            super
              .query(request)
              .toPromise()
              .then((res) => {
                this.getResults(request, res)
                  .then((r) => {
                    if (r && r.data && r.data) {
                      resolve(getTemplateVariablesFromResult(r.data[0]) as MetricFindValue[]);
                    } else {
                      resolve([]);
                    }
                  })
                  .catch((ex) => {
                    console.error(ex);
                    resolve([]);
                  });
              })
              .catch((ex) => {
                console.error(ex);
                resolve([]);
              });
          } else {
            resolve([]);
          }
          break;
        case 'legacy':
        default:
          // eslint-disable-next-line no-case-declarations
          const legacyVariableProvider = new LegacyVariableProvider(query.query);
          legacyVariableProvider.query().then((res) => resolve(flatten(res)));
          break;
      }
    });
  }
  testDatasource() {
    if (this.instanceSettings.basicAuth || this.instanceSettings.jsonData?.oauthPassThru || (this.instanceSettings.jsonData?.auth_method && this.instanceSettings.jsonData?.auth_method !== 'none')) {
      if (!this.instanceSettings?.jsonData?.allowedHosts || (this.instanceSettings?.jsonData?.allowedHosts && this.instanceSettings?.jsonData?.allowedHosts.length < 1)) {
        return Promise.resolve({ status: 'error', message: 'Configure allowed hosts in the authentication section' });
      }
    }
    return super.testDatasource();
  }
  private resolveData = (t: InfinityQuery, range: TimeRange, scopedVars: ScopedVars, data: string): Promise<any> => {
    return new Promise((resolve, reject) => {
      switch (t.type) {
        case 'csv':
        case 'tsv':
        case 'html':
        case 'json':
        case 'xml':
        case 'graphql':
          if (t.format === 'as-is' && t.source === 'inline') {
            const data = JSON.parse(t.data || '[]');
            resolve(data);
          }
          new InfinityProvider(t, this).formatResults(data).then(resolve).catch(reject);
          break;
        case 'uql':
          applyUQL(t.uql, data, t.format, t.refId).then(resolve).catch(reject);
          break;
        case 'groq':
          applyGroq(t.groq, data, t.format, t.refId).then(resolve).catch(reject);
          break;
        case 'series':
          new SeriesProvider(interpolateQuery(t, scopedVars)).query(new Date(range?.from?.toDate()).getTime(), new Date(range?.to?.toDate()).getTime()).then(resolve).catch(reject);
          break;
        case 'global':
          reject('Query not found');
          break;
        default:
          reject('Unknown Query Type');
          break;
      }
    });
  };
  private getResults(options: DataQueryRequest<InfinityQuery>, result: DataQueryResponse): Promise<DataQueryResponse> {
    if (result && result.error) {
      return Promise.reject(JSON.stringify(result.error || { msg: 'error getting result', error: result.error }));
    }
    const promises: Array<Promise<DataFrame>> = [];
    if (result && result.data) {
      result.data.map((d) => {
        const target: InfinityQuery = d.meta?.custom?.query;
        const data = d.meta?.custom?.data;
        const responseCodeFromServer = d.meta?.custom?.responseCodeFromServer;
        const error = d.meta?.custom?.error;
        if (target.type === 'json-backend') {
          promises.push(Promise.resolve(d));
        } else {
          promises.push(
            this.resolveData(target, options.range, options.scopedVars, data).then((r) => {
              if (target.type === 'json' && target.format === 'as-is') {
                return r;
              } else if (
                (target.type === 'csv' || target.type === 'json' || target.type === 'xml' || target.type === 'graphql' || target.type === 'uql' || target.type === 'groq') &&
                target.format !== 'timeseries'
              ) {
                const df = toDataFrame(r);
                let frame = { ...df, meta: d.meta, refId: target.refId };
                if (error || (responseCodeFromServer && responseCodeFromServer >= 400)) {
                  frame.meta.notices = [
                    {
                      severity: 'error',
                      text: `Response code from server : ${responseCodeFromServer}. Error Message : ${error || '-'}`,
                    },
                  ];
                } else if (responseCodeFromServer && responseCodeFromServer > 300) {
                  frame.meta.notices = [{ severity: 'warning', text: `Response Code From Server : ${responseCodeFromServer}` }];
                }
                if (target.format === 'node-graph-edges' || target.format === 'node-graph-nodes') {
                  frame.meta.preferredVisualisationType = 'nodeGraph';
                }
                return frame;
              }
              return r;
            })
          );
        }
      });
    }
    return Promise.all(promises)
      .then((results) => {
        return { data: flatten(results) };
      })
      .catch((ex) => {
        throw ex;
      });
  }
  getQueryDisplayText(query: InfinityQuery) {
    return (
      query.type.toUpperCase() +
      ((query.type === 'json' ||
        query.type === 'csv' ||
        query.type === 'xml' ||
        query.type === 'uql' ||
        query.type === 'graphql' ||
        query.type === 'groq' ||
        query.type === 'json-backend' ||
        query.type === 'tsv') &&
      query.source === 'url'
        ? ` ${query.url}`
        : '')
    );
  }
  filterQuery(query: InfinityQuery) {
    if (query.hide) {
      return false;
    }
    return true;
  }
}
