// request-context.interceptor.ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { requestContext } from 'src/context/request.context';
import { randomUUID } from 'crypto';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();

    const userId = req.user?.userId; // Agora funciona porque o guard já rodou

    // Uma requisição, um id: é o que agrupa as várias escritas de uma mesma
    // ação na tela de atividades, sem depender de os horários baterem.
    const requestId = randomUUID();

    return new Observable((subscriber) => {
      requestContext.run({ userId, requestId }, () => {
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });
    });
  }
}
