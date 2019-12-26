#
#  mix.exs
#  api
# 
#  Created by Wess Cope (me@wess.io) on 12/11/19
#  Copyright 2019 Wess Cope
#

defmodule Api.MixProject do
  use Mix.Project

  def project do
    [
      app:              :api,
      version:          "0.0.1",
      build_path:       "../../_build",
      config_path:      "../../config/config.exs",
      deps_path:        "../../deps",
      lockfile:         "../../mix.lock",
      elixir:           "~> 1.9",
      start_permanent:  Mix.env() == :prod,
      deps:             deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
      mod: {Api.Application, []}
    ]
  end

  defp microservices do
    [
      {:documents,    in_umbrella: true},
      {:attachments,  in_umbrella: true},
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:ext, in_umbrella: true}, 
    ] ++ microservices()
  end
end
