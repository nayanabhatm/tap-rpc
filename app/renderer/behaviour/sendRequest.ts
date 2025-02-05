import { EventEmitter } from "events";
import { credentials, Metadata, ServiceError } from "@grpc/grpc-js";
import type { RpcProtoInfo } from './models';
import * as fs from "fs";
import type {Client as GrpcClient} from '@grpc/grpc-js'
import type { Certificate } from "./certificateImporter";

export interface GRPCRequestInfo {
  url: string;
  rpcProtoInfo: RpcProtoInfo;
  metadata: string;
  inputs: string;
  interactive?: boolean;
  tlsCertificate?: Certificate
}

export interface ResponseMetaInformation {
  responseTime?: number;
  stream?: boolean;
}

export const GRPCEventType = {
  DATA: "DATA",
  ERROR: "ERROR",
  END: "END",
};

export class GRPCRequest extends EventEmitter {
  url: string;
  rpcProtoInfo: RpcProtoInfo;
  metadata: string;
  inputs: string;
  interactive?: boolean;
  tlsCertificate?: Certificate;
  _call?: any;

  constructor({ url, rpcProtoInfo: protoInfo, metadata, inputs, interactive, tlsCertificate }: GRPCRequestInfo) {
    super();
    this.url = url;
    this.rpcProtoInfo = protoInfo;
    this.metadata = metadata;
    this.inputs = inputs;
    this.interactive = interactive;
    this.tlsCertificate = tlsCertificate;
    this._call = undefined;
  }

  send(): GRPCRequest {
    const serviceClient: any = this.rpcProtoInfo.client;
    const client: GrpcClient = this.getClient(serviceClient);
    let inputs = {};
    let metadata: {[key: string]: any} = {};

    try {
      const reqInfo = this.parseRequestInfo(this.inputs, this.metadata);
      inputs = reqInfo.inputs;
      metadata = reqInfo.metadata;
    } catch(e) {
      return this;
    }

    // Add metadata
    const md = new Metadata();
    Object.keys(metadata).forEach(key => {
      if (key.endsWith("-bin")) {
        let encoding : BufferEncoding = "utf-8";
        let value = metadata[key];

        // can prefix the value with any encoding that the buffer supports
        // example:
        // binary://binaryvalue
        // utf8://anyvalue
        // base64://sombase64value
        const regexEncoding = /(^.*):\/\/(.*)/g;
        if (regexEncoding.test(value)) {
          const groups = new RegExp(regexEncoding).exec(value);

          if (groups) {
            encoding = groups[1] as BufferEncoding;
            value = groups[2];
          }
        }

        md.add(key, Buffer.from(value, encoding));
      } else {
        md.add(key, metadata[key]);
      }
    });

    // Gather method information
    const methodDefinition = this.rpcProtoInfo.methodDef();

    // TODO: find proper type for call
    let call: any;
    const requestStartTime = new Date();

    if (methodDefinition.requestStream) {
      // Client side streaming
      call = this.clientSideStreaming(client, inputs, md, requestStartTime);
    } else {
      // Unary call
      call = this.unaryCall(client, inputs, md, requestStartTime);
    }

    // Server Streaming.
    if (methodDefinition.responseStream) {
      this.handleServerStreaming(call, requestStartTime);
    }

    this._call = call;

    this.on(GRPCEventType.END, () => {
      client.close();
    });

    return this;
  }

  /**
   * Write to a stream
   * @param data
   */
  write(data: string) {
    if (this._call) {
      // Add metadata
      let inputs = {};

      try {
        const reqInfo = this.parseRequestInfo(data);
        inputs = reqInfo.inputs;
      } catch(e) {
        return this;
      }
      this._call.write(inputs);
    }
    return this;
  }

  /**
   * Cancel request
   */
  cancel() {
    if (this._call) {
      this._call.cancel();
      this.emit(GRPCEventType.END);
    }
  }

  /**
   * Commit stream
   */
  commitStream() {
    if (this._call) {
      this._call.end();
    }
  }

  /**
   * Get grpc client for this relevant request
   * @param serviceClient
   */
  private getClient(serviceClient: any): GrpcClient {
    let creds = credentials.createInsecure();
    let options = {};

    if (this.tlsCertificate) {
      if (this.tlsCertificate.sslTargetHost) {
        options = {
          ...options,
          'grpc.ssl_target_name_override' : this.tlsCertificate.sslTargetHost,
          'grpc.default_authority': this.tlsCertificate.sslTargetHost,
        }
      }
      if(this.tlsCertificate.useServerCertificate === true) {
        creds = credentials.createSsl();
      } else {
        creds = credentials.createSsl(
            fs.readFileSync(this.tlsCertificate.rootCert.filePath),
            this.tlsCertificate.privateKey && fs.readFileSync(this.tlsCertificate.privateKey.filePath),
            this.tlsCertificate.certChain && fs.readFileSync(this.tlsCertificate.certChain.filePath),
        );
      }
    }

    return new serviceClient(this.url, creds, options);
  }

  /**
   * Issue a client side streaming request
   * @param client
   * @param inputs
   * @param md
   * @param requestStartTime
   */
  private clientSideStreaming(client: any, inputs: any, md: Metadata, requestStartTime?: Date) {
    const call = client[this.rpcProtoInfo.methodName](md, (err: ServiceError, response: any) => {
      this.handleUnaryResponse(err, response, requestStartTime);
    });

    if (inputs && Array.isArray(inputs.stream)) {
      inputs.stream.forEach((data: object) => {
        call.write(data);
      });
    } else {
      call.write(inputs);
    }

    if (!this.interactive) {
      call.end();
    }

    return call;
  }

  /**
   * Handle server side streaming response
   * @param call
   * @param streamStartTime
   */
  private handleServerStreaming(call: any, streamStartTime?: Date) {

    call.on('data', (data: object) => {
      const responseMetaInformation = this.responseMetaInformation(streamStartTime, true);
      this.emit(GRPCEventType.DATA, data, responseMetaInformation);
      streamStartTime = new Date();
    });

    call.on('error', (err: { [key: string]: any }) => {
      const responseMetaInformation = this.responseMetaInformation(streamStartTime, true);
      if (err && err.code !== 1) {
        this.emit(GRPCEventType.ERROR, err, responseMetaInformation);

        if (err.code === 2 || err.code === 14) { // Stream Removed.
          this.emit(GRPCEventType.END, call);
        }
      }
      streamStartTime = new Date();
    });

    call.on('end', () => {
      this.emit(GRPCEventType.END, this);
    });
  }

  /**
   * Send a unary call
   * @param client
   * @param inputs
   * @param md
   * @param requestStartTime
   */
  private unaryCall(client: any, inputs: any, md: Metadata, requestStartTime?: Date) {
    console.log('client :>> ', client);
    console.log('inputs :>> ', inputs);
    return client[this.rpcProtoInfo.methodName](inputs, md, (err: ServiceError, response: any) => {
      console.log('response :>> ', response );
      console.log('err:>> ', err);
      this.handleUnaryResponse(err, response, requestStartTime);
    });
  }

  /**
   * Handle unary response
   * @param err
   * @param response
   * @param requestStartTime
   */
  private handleUnaryResponse(err: ServiceError, response: any, requestStartTime?: Date) {
    const responseMetaInformation = this.responseMetaInformation(requestStartTime);

    // Client side streaming handler
    if (err) {
      // Request cancelled do nothing
      if (err.code === 1) {
        return;
      } else {
        this.emit(GRPCEventType.ERROR, err, responseMetaInformation);
      }
    } else {
      this.emit(GRPCEventType.DATA, response, responseMetaInformation);
    }
    this.emit(GRPCEventType.END);
  }

  /**
   * Response meta information
   * @param startTime
   * @param stream
   */
  private responseMetaInformation(startTime?: Date, stream?: boolean) {
    const responseDate = new Date();

    return {
      responseTime: startTime && (responseDate.getTime() - startTime.getTime()) / 1000,
      stream,
    };
  }

  /**
   * Parse JSON to request inputs / metadata
   * @param data
   * @param userMetadata
   */
  private parseRequestInfo(data: string, userMetadata?: string): { inputs: object, metadata: object } {
    let inputs = {};
    let metadata: {[key: string]: any} = {};

    try {
      inputs = JSON.parse(data || "{}")
    } catch (e) {
      e.message = "Couldn't parse JSON inputs Invalid json";
      this.emit(GRPCEventType.ERROR, e, {});
      this.emit(GRPCEventType.END);
      throw new Error(e);
    }

    if (userMetadata) {
      try {
        metadata = JSON.parse(userMetadata || "{}")
      } catch (e) {
        e.message = "Couldn't parse JSON metadata Invalid json";
        this.emit(GRPCEventType.ERROR, e, {});
        this.emit(GRPCEventType.END);
        throw new Error(e);
      }
    }

    return { inputs, metadata };
  }
}
