import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET,
    });
  }

  async validate(payload: any) {
    // `role` é só uma pista vinda do token (pode estar defasada por até 24h).
    // A autorização de verdade é feita pelo RolesGuard, que lê o perfil do banco.
    return {
      userId: payload.sub,
      username: payload.username,
      role: payload.role,
    };
  }
}
