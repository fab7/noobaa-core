import * as model from 'model';
import { action$, state$ } from 'state';
import * as actionCreators from 'action-creators';
import schema from 'schema';
import api from 'services/api';
import { mapValues } from 'utils/core-utils';
import { toObjectUrl, openInNewTab, downloadFile, getWindowName } from 'utils/browser-utils';

const actions = mapValues(
    actionCreators,
    creator => function(...args) {
        action$.onNext(creator(...args));
    }
);

function printAsJsonInNewTab(data) {
    openInNewTab(toObjectUrl(data));
}

function downloadAsJson(data, name = 'data.json') {
    downloadFile(toObjectUrl(data), name);
}

function openDebugConsole() {
    const [,windowId] = getWindowName().split(':');
    openInNewTab('/fe/debug', `NobaaDebugConsole:${windowId}`);
    return windowId;
}

const cli = Object.seal({
    model: model,
    schema: schema.def,
    actions: actions,
    state: undefined,
    api: api,
    utils: {
        printAsJsonInNewTab,
        downloadAsJson,
        openDebugConsole
    }
});

state$.subscribe(state => { cli.state = state; });

export default cli;
