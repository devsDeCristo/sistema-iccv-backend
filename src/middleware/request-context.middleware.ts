// request-context.interceptor.ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { requestContext } from 'src/context/request.context';
import { randomUUID } from 'crypto';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();

    const userId = req.user?.userId; // Agora funciona porque o guard já rodou

    // Uma requisição, um id: é o que agrupa as várias escritas de uma mesma
    // ação na tela de atividades, sem depender de os horários baterem.
    const requestId = randomUUID();

    const operation = this.operacaoDe(context, req);

    return new Observable((subscriber) => {
      requestContext.run({ userId, requestId, operation }, () => {
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });
    });
  }

  /**
   * O que foi pedido, no molde da rota: `POST /events/:idEvent/users/:idUser`.
   *
   * O molde, e não a URL de verdade: com os ids dentro, cada inscrição seria
   * uma operação diferente e não daria para contar nem filtrar por elas. Vem
   * dos metadados do Nest, e não de `req.route`, porque ali o caminho depende
   * de como o adaptador HTTP registrou a rota.
   */
  private operacaoDe(
    context: ExecutionContext,
    req: { method?: string },
  ): string | undefined {
    if (context.getType() !== 'http' || !req?.method) return undefined;

    const doControlador = this.reflector.get<string>(
      PATH_METADATA,
      context.getClass(),
    );
    const doMetodo = this.reflector.get<string>(
      PATH_METADATA,
      context.getHandler(),
    );

    // `@Post()` sem argumento vira '/', e o prefixo do controller pode vir com
    // barra nas duas pontas: junta tudo e normaliza de uma vez
    const caminho =
      ['', doControlador, doMetodo]
        .join('/')
        .replace(/\/{2,}/g, '/')
        .replace(/(.)\/$/, '$1') || '/';

    return `${req.method} ${caminho}`;
  }
}
