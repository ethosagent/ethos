export class EthosClient {
    rpc;
    dispatcher;
    constructor(dispatcher) {
        this.dispatcher = dispatcher;
        this.rpc = dispatcher.rpc;
    }
    stream(...args) {
        return this.dispatcher.stream(...args);
    }
}
